import { createHash } from 'node:crypto';

import type { AxiosInstance } from 'axios';

import { adfToMarkdown, isAdfDocument } from './adf.js';
import { createJiraClient } from './client.js';
import { handleJiraError } from './error.js';
import { readFieldValue } from './fields.js';
import { markdownToAdf } from './markdown.js';
import { getAllFields } from './meta.js';
import { normalizeName } from './names.js';

import type { AdfDocument, AdfNode } from './adf.js';

import type { JiraFieldSpec } from '../types/jira.js';

/**
 * Mover issues de un proyecto a otro de la misma instancia, con la API de
 * movimiento en lote de Jira Cloud.
 *
 * La API no mueve una jerarquía de una vez: una épica y sus hijos van en
 * peticiones distintas —primero la épica, después los hijos con la épica como
 * padre—, cada una es una tarea asíncrona y Jira no deshace ninguna. Por eso
 * el trabajo se reparte en fases por profundidad, cada fase espera a que
 * termine la anterior, y un fallo detiene las siguientes: mover los hijos de
 * una épica que no se movió partiría la jerarquía todavía más.
 *
 * Todo lo que la API resolvería por su cuenta en silencio se decide aquí antes
 * de enviar nada: un estado sin equivalente iría al estado inicial del destino
 * (`inferStatusDefaults`), y un tipo de subtarea, al primero que Jira
 * encuentre (`inferSubtaskTypeDefault`). Los dos se dejan en `false` y lo
 * que no tiene equivalente se informa como bloqueo.
 */

export interface MoveIssuesInput {
    issueKeys: string[];
    targetProject: string;
    includeChildren?: boolean;
    mode?: 'plan' | 'execute';
    typeMapping?: Record<string, string>;
    statusMapping?: Record<string, string>;
    preserveLostFields?: boolean;
    notify?: boolean;
    planId?: string;
    timeoutSeconds?: number;
}

/** Aviso de avance que la herramienta reenvía al cliente, si lo admite. */
export type MoveProgress = (
    message: string,
    progress: number,
    total?: number,
) => Promise<void>;

export interface RawIssue {
    id: string;
    key: string;
    fields: {
        summary: string;
        project: { id: string; key: string };
        issuetype: {
            id: string;
            name: string;
            subtask: boolean;
            hierarchyLevel?: number;
        };
        status: { id: string; name: string };
        parent?: { id: string; key: string };
        description?: unknown;
        [field: string]: unknown;
    };
}

export interface TargetIssueType {
    id: string;
    name: string;
    subtask: boolean;
    hierarchyLevel?: number;
}

export interface TargetProject {
    id: string;
    key: string;
    name: string;
    issueTypes: TargetIssueType[];
}

interface CreateField {
    id: string;
    name: string;
    required: boolean;
    hasDefaultValue: boolean;
}

interface LostField {
    id: string;
    name: string;
    /** Contenido legible, el que se añadiría a la descripción. */
    value: string;
    /** Un campo del destino con el mismo nombre pero otro identificador. */
    sameNameInTarget?: string;
}

interface PlannedIssue {
    raw: RawIssue;
    key: string;
    id: string;
    sourceProject: string;
    sourceType: { id: string; name: string };
    sourceStatus: { id: string; name: string };
    targetType?: TargetIssueType;
    targetStatus?: { id: string; name: string };
    /** El estado de origen no existe en el destino y hay que mapearlo. */
    statusNeedsMapping: boolean;
    parent?: { id: string; key: string; inBatch: boolean };
    subtask: boolean;
    phase: number;
    lostFields: LostField[];
    alreadyInTarget: boolean;
}

export interface Blocker {
    key?: string;
    reason: string;
}

interface Plan {
    planId?: string;
    target: TargetProject;
    issues: PlannedIssue[];
    blockers: Blocker[];
    warnings: string[];
    /** Fases con lo que hay que mover en cada una, ya repartido en lotes. */
    phases: PlannedIssue[][][];
}

const MAX_COLLECTED = 5000;
const MAX_PER_REQUEST = 1000;
const FETCH_CHUNK = 100;
const JQL_CHUNK = 50;
const PLAN_TTL_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_SECONDS = 300;
const LISTED_ISSUES = 200;

/** Título con que se marca lo añadido a la descripción, para no repetirlo. */
const PRESERVED_HEADING = 'Campos conservados al mover de proyecto';

/**
 * Campos que el movimiento conserva o recalcula por su cuenta, o que no son
 * contenido de quien escribe el issue: no se comparan con el destino.
 */
const NOT_COMPARED = new Set([
    'summary',
    'project',
    'issuetype',
    'status',
    'statuscategorychangedate',
    'statusCategory',
    'parent',
    'subtasks',
    'issuelinks',
    'comment',
    'worklog',
    'attachment',
    'watches',
    'votes',
    'creator',
    'reporter',
    'assignee',
    'created',
    'updated',
    'lastViewed',
    'resolution',
    'resolutiondate',
    'workratio',
    'timetracking',
    'timespent',
    'timeestimate',
    'timeoriginalestimate',
    'aggregatetimespent',
    'aggregatetimeestimate',
    'aggregatetimeoriginalestimate',
    'aggregateprogress',
    'progress',
    'security',
    'issuerestriction',
    'thumbnail',
]);

/**
 * Campos que pertenecen al proyecto de origen: sus valores —versiones,
 * componentes— no existen en el destino aunque el campo sí.
 */
export const PROJECT_SCOPED = new Set(['fixVersions', 'versions', 'components']);

/**
 * Campos personalizados que mantiene Jira, no quien escribe el issue: el
 * orden, el panel de desarrollo, el tiempo en cada estado, y los campos
 * heredados de las épicas clásicas, que hoy se derivan del propio issue.
 * Copiarlos a la descripción solo añadiría ruido.
 */
export const MACHINE_FIELD_TYPES = new Set([
    'gh-lexo-rank',
    'devsummarycf',
    'vulnerabilitycf',
    'timeinstatus',
    'gh-epic-link',
    'gh-epic-label',
    'gh-epic-status',
    'gh-epic-color',
    'jsw-issue-color',
]);

const issuedPlans = new Map<string, number>();

export function chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];

    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
    }

    return chunks;
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isEmpty(value: unknown): boolean {
    if (value === null || value === undefined) {
        return true;
    }

    if (typeof value === 'string') {
        return value.trim().length === 0 || value === '{}';
    }

    if (Array.isArray(value)) {
        return value.length === 0;
    }

    if (isAdfDocument(value)) {
        const text = adfToMarkdown(value);

        return text === null || text.trim().length === 0;
    }

    if (typeof value === 'object') {
        return Object.keys(value).length === 0;
    }

    return false;
}

export function toText(value: unknown): string {
    if (value === null || value === undefined) {
        return '';
    }

    if (typeof value === 'string') {
        return value;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }

    if (Array.isArray(value)) {
        return value
            .map(toText)
            .filter((text) => text.length > 0)
            .join(', ');
    }

    const object = value as Record<string, unknown>;

    if (typeof object.name === 'string') {
        return object.name;
    }

    if (typeof object.key === 'string') {
        return object.key;
    }

    return JSON.stringify(value);
}

export function lookup(
    mapping: Record<string, string> | undefined,
    ...candidates: string[]
): string | undefined {
    if (!mapping) {
        return undefined;
    }

    const wanted = new Set(candidates.map(normalizeName));

    const entry = Object.entries(mapping).find(([from]) =>
        wanted.has(normalizeName(from)),
    );

    return entry?.[1];
}

// --- Lecturas -------------------------------------------------------------

export async function fetchIssues(
    client: AxiosInstance,
    idsOrKeys: string[],
): Promise<{ issues: RawIssue[]; missing: string[] }> {
    const issues: RawIssue[] = [];

    for (const part of chunk(idsOrKeys, FETCH_CHUNK)) {
        const response = await client.post<{ issues: RawIssue[] }>(
            '/rest/api/3/issue/bulkfetch',
            { issueIdsOrKeys: part, fields: ['*all'] },
        );

        issues.push(...response.data.issues);
    }

    // La respuesta no dice qué identificador pedido corresponde a cada issue:
    // una clave antigua vuelve con la nueva. Lo que no se encuentra ni por id
    // ni por clave se da por inexistente o sin permiso.
    const found = new Set(
        issues.flatMap((issue) => [issue.id, issue.key.toUpperCase()]),
    );

    const missing = idsOrKeys.filter(
        (wanted) => !found.has(wanted.toUpperCase()),
    );

    return { issues, missing };
}

async function searchChildren(
    client: AxiosInstance,
    parentIds: string[],
): Promise<RawIssue[]> {
    const children: RawIssue[] = [];

    for (const part of chunk(parentIds, JQL_CHUNK)) {
        let nextPageToken: string | undefined;

        do {
            const response = await client.post<{
                issues: RawIssue[];
                nextPageToken?: string;
            }>('/rest/api/3/search/jql', {
                jql: `parent in (${part.join(',')}) ORDER BY id`,
                maxResults: 100,
                fields: ['*all'],
                ...(nextPageToken !== undefined && { nextPageToken }),
            });

            children.push(...response.data.issues);
            nextPageToken = response.data.nextPageToken;

            if (response.data.issues.length === 0) {
                break;
            }
        } while (nextPageToken !== undefined);
    }

    return children;
}

/**
 * Reúne los issues pedidos y, si se piden los hijos, desciende nivel a nivel:
 * una épica trae sus historias y tareas, y estas sus subtareas.
 */
export async function collectIssues(
    client: AxiosInstance,
    keys: string[],
    includeChildren: boolean,
): Promise<{ issues: RawIssue[]; missing: string[] }> {
    const { issues, missing } = await fetchIssues(client, keys);

    const collected = new Map(issues.map((issue) => [issue.id, issue]));

    let frontier = [...collected.keys()];

    while (includeChildren && frontier.length > 0) {
        const children = await searchChildren(client, frontier);

        frontier = [];

        for (const child of children) {
            if (!collected.has(child.id)) {
                collected.set(child.id, child);
                frontier.push(child.id);
            }
        }

        if (collected.size > MAX_COLLECTED) {
            throw new Error(
                `El lote pasa de ${MAX_COLLECTED} issues contando los hijos. Dividirlo en varias llamadas o usar includeChildren: false.`,
            );
        }
    }

    return { issues: [...collected.values()], missing };
}

export async function fetchTargetProject(
    client: AxiosInstance,
    key: string,
): Promise<TargetProject> {
    const response = await client.get<TargetProject>(
        `/rest/api/3/project/${key}`,
    );

    const { id, key: projectKey, name, issueTypes } = response.data;

    return {
        id,
        key: projectKey,
        name,
        issueTypes: issueTypes.map((type) => ({
            id: type.id,
            name: type.name,
            subtask: type.subtask,
            hierarchyLevel: type.hierarchyLevel,
        })),
    };
}

export async function fetchTargetStatuses(
    client: AxiosInstance,
    key: string,
): Promise<Map<string, Array<{ id: string; name: string }>>> {
    const response = await client.get<
        Array<{ id: string; statuses: Array<{ id: string; name: string }> }>
    >(`/rest/api/3/project/${key}/statuses`);

    return new Map(
        response.data.map((type) => [
            type.id,
            type.statuses.map(({ id, name }) => ({ id, name })),
        ]),
    );
}

async function fetchCreateFields(
    client: AxiosInstance,
    projectKey: string,
    issueTypeId: string,
): Promise<CreateField[]> {
    const fields: CreateField[] = [];

    let startAt = 0;

    for (;;) {
        const response = await client.get<{
            total: number;
            fields: Array<{
                fieldId?: string;
                key?: string;
                name: string;
                required: boolean;
                hasDefaultValue?: boolean;
            }>;
        }>(
            `/rest/api/3/issue/createmeta/${projectKey}/issuetypes/${issueTypeId}`,
            { params: { startAt, maxResults: 100 } },
        );

        const page = response.data.fields;

        fields.push(
            ...page.map((field) => ({
                id: field.fieldId ?? field.key ?? '',
                name: field.name,
                required: field.required,
                hasDefaultValue: field.hasDefaultValue ?? false,
            })),
        );

        startAt += page.length;

        if (page.length === 0 || startAt >= response.data.total) {
            break;
        }
    }

    return fields;
}

export async function hasPermissions(
    client: AxiosInstance,
    permissions: string[],
    projectKey?: string,
): Promise<Record<string, boolean>> {
    const response = await client.get<{
        permissions: Record<string, { havePermission: boolean }>;
    }>('/rest/api/3/mypermissions', {
        params: {
            permissions: permissions.join(','),
            ...(projectKey !== undefined && { projectKey }),
        },
    });

    return Object.fromEntries(
        permissions.map((permission) => [
            permission,
            response.data.permissions[permission]?.havePermission === true,
        ]),
    );
}

// --- Plan -----------------------------------------------------------------

export function resolveType(
    issue: RawIssue,
    target: TargetProject,
    typeMapping: Record<string, string> | undefined,
    action = 'mover',
): { type?: TargetIssueType; blocker?: string } {
    const source = issue.fields.issuetype;

    const mapped = lookup(typeMapping, source.name, source.id);

    const wanted = mapped ?? source.name;

    const type = target.issueTypes.find(
        (candidate) =>
            candidate.id === wanted ||
            normalizeName(candidate.name) === normalizeName(wanted),
    );

    const available = target.issueTypes
        .map((candidate) => candidate.name)
        .join(', ');

    if (!type) {
        return {
            blocker: mapped
                ? `typeMapping lleva "${source.name}" a "${mapped}", que no existe en ${target.key}. Tipos del destino: ${available}.`
                : `El tipo "${source.name}" no existe en ${target.key}. Indicar su equivalente en typeMapping. Tipos del destino: ${available}.`,
        };
    }

    const sameLevel =
        type.subtask === source.subtask &&
        (type.hierarchyLevel === undefined ||
            source.hierarchyLevel === undefined ||
            type.hierarchyLevel === source.hierarchyLevel);

    if (!sameLevel) {
        return {
            blocker: `"${source.name}" y "${type.name}" (${target.key}) no son del mismo nivel: ${action} cambiaría la jerarquía. Elegir en typeMapping un tipo del mismo nivel.`,
        };
    }

    return { type };
}

function resolveStatus(
    issue: RawIssue,
    type: TargetIssueType,
    statuses: Map<string, Array<{ id: string; name: string }>>,
    statusMapping: Record<string, string> | undefined,
    target: string,
    warnings: Set<string>,
): { status?: { id: string; name: string }; needsMapping: boolean; blocker?: string } {
    const source = issue.fields.status;

    const valid = statuses.get(type.id) ?? [];

    const mapped = lookup(statusMapping, source.name, source.id);

    if (valid.some((status) => status.id === source.id)) {
        if (mapped !== undefined && normalizeName(mapped) !== normalizeName(source.name)) {
            warnings.add(
                `El estado "${source.name}" existe en ${target} (${type.name}) y Jira lo conserva: statusMapping no se aplica a él.`,
            );
        }

        return { status: { id: source.id, name: source.name }, needsMapping: false };
    }

    const wanted = mapped ?? source.name;

    const status = valid.find(
        (candidate) =>
            candidate.id === wanted ||
            normalizeName(candidate.name) === normalizeName(wanted),
    );

    const available = valid.map((candidate) => candidate.name).join(', ');

    if (!status) {
        return {
            needsMapping: true,
            blocker: mapped
                ? `statusMapping lleva "${source.name}" a "${mapped}", que no es un estado de ${type.name} en ${target}. Estados posibles: ${available}.`
                : `El estado "${source.name}" no existe para ${type.name} en ${target}. Indicar su equivalente en statusMapping. Estados posibles: ${available}.`,
        };
    }

    return { status, needsMapping: true };
}

function findLostFields(
    issue: RawIssue,
    createFields: CreateField[],
    catalog: Map<string, JiraFieldSpec>,
): LostField[] {
    const inTarget = new Set(createFields.map((field) => field.id));

    const lost: LostField[] = [];

    for (const [id, value] of Object.entries(issue.fields)) {
        if (NOT_COMPARED.has(id) || isEmpty(value)) {
            continue;
        }

        const spec = catalog.get(id);

        const custom = id.startsWith('customfield_');

        if (custom && spec?.custom && MACHINE_FIELD_TYPES.has(spec.custom)) {
            continue;
        }

        // Solo se comparan los campos personalizados y los de sistema que
        // admiten contenido propio: el resto los recalcula Jira.
        const comparable =
            custom ||
            PROJECT_SCOPED.has(id) ||
            ['description', 'environment', 'duedate', 'labels', 'priority'].includes(id);

        if (!comparable) {
            continue;
        }

        if (inTarget.has(id) && !PROJECT_SCOPED.has(id)) {
            continue;
        }

        const name = spec?.name ?? id;

        const twin = createFields.find(
            (field) =>
                field.id !== id && normalizeName(field.name) === normalizeName(name),
        );

        lost.push({
            id,
            name,
            value: toText(readFieldValue(value)),
            ...(twin && { sameNameInTarget: twin.id }),
        });
    }

    return lost;
}

/**
 * Fase de cada issue: la profundidad dentro del lote. Una subtarea va en la
 * misma petición que su padre —así lo admite la API—, y un hijo estándar en la
 * siguiente, con el padre ya movido.
 */
function assignPhases(issues: PlannedIssue[]): void {
    const byId = new Map(issues.map((issue) => [issue.id, issue]));

    const depth = (issue: PlannedIssue, seen = new Set<string>()): number => {
        const parent = issue.parent?.inBatch ? byId.get(issue.parent.id) : undefined;

        if (!parent || seen.has(issue.id)) {
            return 0;
        }

        seen.add(issue.id);

        const parentPhase = depth(parent, seen);

        return issue.subtask ? parentPhase : parentPhase + 1;
    };

    for (const issue of issues) {
        issue.phase = depth(issue);
    }
}

function mappingKey(issue: PlannedIssue, target: TargetProject): string {
    const base = `${target.id},${issue.targetType!.id}`;

    // Una subtarea que viaja con su padre no lleva padre en la clave: Jira la
    // mueve con él. Un hijo estándar, o una subtarea cuyo padre ya está en el
    // destino, sí: es lo que conserva la jerarquía.
    if (!issue.parent) {
        return base;
    }

    if (issue.subtask && issue.parent.inBatch) {
        return base;
    }

    return `${base},${issue.parent.id}`;
}

/**
 * Reparte una fase en lotes de como mucho 1000 issues, sin separar nunca una
 * subtarea de su padre.
 */
function splitPhase(issues: PlannedIssue[]): PlannedIssue[][] {
    const ids = new Set(issues.map((issue) => issue.id));

    const units = new Map<string, PlannedIssue[]>();

    for (const issue of issues) {
        const anchor =
            issue.subtask && issue.parent && ids.has(issue.parent.id)
                ? issue.parent.id
                : issue.id;

        units.set(anchor, [...(units.get(anchor) ?? []), issue]);
    }

    const batches: PlannedIssue[][] = [];

    let current: PlannedIssue[] = [];

    for (const unit of units.values()) {
        if (current.length > 0 && current.length + unit.length > MAX_PER_REQUEST) {
            batches.push(current);
            current = [];
        }

        current.push(...unit);
    }

    if (current.length > 0) {
        batches.push(current);
    }

    return batches;
}

function computePlanId(input: MoveIssuesInput, issues: PlannedIssue[]): string {
    const sorted = (mapping?: Record<string, string>) =>
        Object.entries(mapping ?? {})
            .map(([from, to]) => [normalizeName(from), normalizeName(to)])
            .sort();

    const canonical = JSON.stringify({
        keys: [...new Set(input.issueKeys.map((key) => key.trim().toUpperCase()))].sort(),
        target: input.targetProject.trim().toUpperCase(),
        includeChildren: input.includeChildren ?? true,
        typeMapping: sorted(input.typeMapping),
        statusMapping: sorted(input.statusMapping),
        preserveLostFields: input.preserveLostFields ?? true,
        notify: input.notify ?? false,
        // Lo que hay en Jira también forma parte del plan: si un issue cambia
        // de estado o aparece un hijo nuevo, lo aprobado ya no es esto.
        issues: issues
            .map(
                (issue) =>
                    `${issue.id}:${issue.raw.fields.project.key}:${issue.sourceType.id}:${issue.sourceStatus.id}:${issue.parent?.id ?? ''}`,
            )
            .sort(),
    });

    return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

async function buildPlan(
    client: AxiosInstance,
    input: MoveIssuesInput,
): Promise<Plan> {
    const keys = [...new Set(input.issueKeys.map((key) => key.trim()).filter(Boolean))];

    if (keys.length === 0) {
        throw new Error('No se ha indicado ningún issue que mover.');
    }

    const targetKey = input.targetProject.trim().toUpperCase();

    const [target, statuses, catalogList, collected] = await Promise.all([
        fetchTargetProject(client, targetKey),
        fetchTargetStatuses(client, targetKey),
        getAllFields(),
        collectIssues(client, keys, input.includeChildren ?? true),
    ]);

    const catalog = new Map(catalogList.map((field) => [field.id, field]));

    const blockers: Blocker[] = collected.missing.map((key) => ({
        key,
        reason: 'No existe o no hay permiso para verlo.',
    }));

    const warnings = new Set<string>();

    // Un padre cuenta como «en el lote» solo si se mueve ahora: uno que ya
    // está en el destino —un reintento tras un fallo— se trata como externo.
    const moving = new Set(
        collected.issues
            .filter((issue) => issue.fields.project.key !== target.key)
            .map((issue) => issue.id),
    );

    const createFieldsByType = new Map<string, CreateField[]>();

    const issues: PlannedIssue[] = [];

    for (const raw of collected.issues) {
        const alreadyInTarget = raw.fields.project.key === target.key;

        const parent = raw.fields.parent
            ? {
                  id: raw.fields.parent.id,
                  key: raw.fields.parent.key,
                  inBatch: moving.has(raw.fields.parent.id),
              }
            : undefined;

        const planned: PlannedIssue = {
            raw,
            key: raw.key,
            id: raw.id,
            sourceProject: raw.fields.project.key,
            sourceType: { id: raw.fields.issuetype.id, name: raw.fields.issuetype.name },
            sourceStatus: { id: raw.fields.status.id, name: raw.fields.status.name },
            statusNeedsMapping: false,
            ...(parent && { parent }),
            subtask: raw.fields.issuetype.subtask,
            phase: 0,
            lostFields: [],
            alreadyInTarget,
        };

        issues.push(planned);

        if (alreadyInTarget) {
            continue;
        }

        const { type, blocker: typeBlocker } = resolveType(raw, target, input.typeMapping);

        if (typeBlocker) {
            blockers.push({ key: raw.key, reason: typeBlocker });
            continue;
        }

        planned.targetType = type;

        const { status, needsMapping, blocker: statusBlocker } = resolveStatus(
            raw,
            type!,
            statuses,
            input.statusMapping,
            target.key,
            warnings,
        );

        planned.statusNeedsMapping = needsMapping;

        if (statusBlocker) {
            blockers.push({ key: raw.key, reason: statusBlocker });
        } else {
            planned.targetStatus = status;
        }

        const parentInTarget = parent?.key.split('-')[0] === target.key;

        if (planned.subtask && parent && !parent.inBatch && !parentInTarget) {
            blockers.push({
                key: raw.key,
                reason: `Es una subtarea y su padre ${parent.key} no se mueve: una subtarea vive en el proyecto de su padre. Mover el padre, o dejar fuera la subtarea.`,
            });
        }

        if (!planned.subtask && parent && !parent.inBatch && !parentInTarget) {
            warnings.add(
                `${raw.key} tiene de padre a ${parent.key}, que no se mueve. Se pide a Jira conservarlo; la verificación dirá si lo hizo.`,
            );
        }

        let createFields = createFieldsByType.get(type!.id);

        if (!createFields) {
            createFields = await fetchCreateFields(client, target.key, type!.id);
            createFieldsByType.set(type!.id, createFields);
        }

        for (const field of createFields) {
            if (
                field.required &&
                !field.hasDefaultValue &&
                !['project', 'issuetype', 'summary', 'parent', 'reporter'].includes(field.id) &&
                isEmpty(raw.fields[field.id])
            ) {
                blockers.push({
                    key: raw.key,
                    reason: `El campo "${field.name}" (${field.id}) es obligatorio en ${target.key} para ${type!.name} y está vacío. Rellenarlo antes de mover.`,
                });
            }
        }

        planned.lostFields = findLostFields(raw, createFields, catalog);

        const preserve = input.preserveLostFields ?? true;

        const keepsDescription = createFields.some((field) => field.id === 'description');

        if (preserve && planned.lostFields.length > 0 && !keepsDescription) {
            blockers.push({
                key: raw.key,
                reason: `Se perderían campos con contenido y ${type!.name} no tiene descripción en ${target.key} donde conservarlos. Usar preserveLostFields: false si se aceptan perder.`,
            });
        }
    }

    assignPhases(issues);

    const toMove = issues.filter((issue) => !issue.alreadyInTarget);

    if (toMove.length === 0 && blockers.length === 0) {
        warnings.add(`Todos los issues ya están en ${target.key}: no hay nada que mover.`);
    }

    // Permisos: el global de cambio en lote, mover en cada origen y crear en
    // el destino. Escribir la descripción sin avisar a los observadores exige
    // además administrar el proyecto; sin ese permiso Jira avisa igual.
    const sourceProjects = [...new Set(toMove.map((issue) => issue.sourceProject))];

    const preserving =
        (input.preserveLostFields ?? true) && toMove.some((issue) => issue.lostFields.length > 0);

    const [targetPermissions, ...sourcePermissions] = await Promise.all([
        hasPermissions(client, ['BULK_CHANGE', 'CREATE_ISSUES'], target.key),
        ...sourceProjects.map((project) =>
            hasPermissions(
                client,
                ['MOVE_ISSUES', 'EDIT_ISSUES', 'ADMINISTER_PROJECTS', 'ADMINISTER'],
                project,
            ),
        ),
    ]);

    if (!targetPermissions.BULK_CHANGE) {
        blockers.push({
            reason: 'Falta el permiso global «Cambio en lote» (Bulk change), que exige la API de movimiento.',
        });
    }

    if (!targetPermissions.CREATE_ISSUES) {
        blockers.push({ reason: `Falta el permiso «Crear incidencias» en ${target.key}.` });
    }

    sourceProjects.forEach((project, index) => {
        const permissions = sourcePermissions[index];

        if (!permissions.MOVE_ISSUES) {
            blockers.push({ reason: `Falta el permiso «Mover incidencias» en ${project}.` });
        }

        const projectPreserving =
            preserving &&
            toMove.some((issue) => issue.sourceProject === project && issue.lostFields.length > 0);

        if (projectPreserving && !permissions.EDIT_ISSUES) {
            blockers.push({
                reason: `preserveLostFields necesita editar la descripción y falta el permiso «Editar incidencias» en ${project}.`,
            });
        }

        if (
            projectPreserving &&
            !(input.notify ?? false) &&
            !permissions.ADMINISTER_PROJECTS &&
            !permissions.ADMINISTER
        ) {
            blockers.push({
                reason: `Escribir en la descripción sin avisar a los observadores exige administrar ${project}, y sin ese permiso Jira avisa igual. Repetir con notify: true para aceptar el aviso, o con preserveLostFields: false.`,
            });
        }
    });

    const phaseCount = Math.max(-1, ...toMove.map((issue) => issue.phase)) + 1;

    const phases = Array.from({ length: phaseCount }, (_, phase) =>
        splitPhase(toMove.filter((issue) => issue.phase === phase)),
    ).filter((batches) => batches.length > 0);

    const plan: Plan = {
        target,
        issues,
        blockers,
        warnings: [...warnings],
        phases,
    };

    if (blockers.length === 0 && toMove.length > 0) {
        plan.planId = computePlanId(input, issues);
    }

    return plan;
}

function describeIssue(issue: PlannedIssue) {
    return {
        key: issue.key,
        summary: issue.raw.fields.summary,
        ...(issue.alreadyInTarget
            ? { note: 'Ya está en el destino: no se mueve.' }
            : {
                  type: `${issue.sourceType.name} → ${issue.targetType?.name ?? '?'}`,
                  status: `${issue.sourceStatus.name} → ${issue.targetStatus?.name ?? '?'}`,
              }),
        ...(issue.parent && { parent: issue.parent.key }),
        ...(issue.lostFields.length > 0 && {
            lostFields: issue.lostFields.map((field) => field.name),
        }),
    };
}

function summarizePlan(plan: Plan) {
    const toMove = plan.issues.filter((issue) => !issue.alreadyInTarget);

    const byType: Record<string, number> = {};

    for (const issue of toMove) {
        const label = `${issue.sourceType.name} → ${issue.targetType?.name ?? 'sin equivalente'}`;

        byType[label] = (byType[label] ?? 0) + 1;
    }

    const lost = new Map<string, { field: string; id: string; keys: string[]; sameNameInTarget?: string }>();

    for (const issue of toMove) {
        for (const field of issue.lostFields) {
            const entry = lost.get(field.id) ?? {
                field: field.name,
                id: field.id,
                keys: [],
                ...(field.sameNameInTarget && { sameNameInTarget: field.sameNameInTarget }),
            };

            entry.keys.push(issue.key);
            lost.set(field.id, entry);
        }
    }

    const alreadyInTarget = plan.issues
        .filter((issue) => issue.alreadyInTarget)
        .map((issue) => issue.key);

    return {
        target: { key: plan.target.key, name: plan.target.name },
        total: toMove.length,
        byType,
        ...(alreadyInTarget.length > 0 && { alreadyInTarget }),
        requests: plan.phases.map((batches, index) => ({
            phase: index + 1,
            issues: batches.reduce((sum, batch) => sum + batch.length, 0),
            requests: batches.length,
        })),
        blockers: plan.blockers,
        lostFields: [...lost.values()].map((entry) => ({
            ...entry,
            ...(entry.sameNameInTarget && {
                note: `En el destino hay un campo con el mismo nombre (${entry.sameNameInTarget}), pero es otro campo: el contenido no pasa.`,
            }),
        })),
        ...(plan.warnings.length > 0 && { warnings: plan.warnings }),
        issues: plan.issues.slice(0, LISTED_ISSUES).map(describeIssue),
        ...(plan.issues.length > LISTED_ISSUES && {
            issuesNote: `Se listan ${LISTED_ISSUES} de ${plan.issues.length}; el resumen cuenta todos.`,
        }),
    };
}

// --- Ejecución ------------------------------------------------------------

function preservedSection(issue: PlannedIssue, target: string): AdfNode[] {
    const nodes: AdfNode[] = [
        { type: 'rule' },
        {
            type: 'heading',
            attrs: { level: 2 },
            content: [
                {
                    type: 'text',
                    text: `${PRESERVED_HEADING} (${issue.sourceProject} → ${target})`,
                },
            ],
        },
    ];

    for (const field of issue.lostFields) {
        if (field.id === 'description') {
            continue;
        }

        nodes.push({
            type: 'heading',
            attrs: { level: 3 },
            content: [{ type: 'text', text: field.name }],
        });

        nodes.push(...markdownToAdf(field.value).content);
    }

    return nodes;
}

function alreadyPreserved(description: unknown): boolean {
    const text = isAdfDocument(description) ? adfToMarkdown(description) : null;

    return text !== null && text.includes(PRESERVED_HEADING);
}

/**
 * Añade al final de la descripción lo que el destino no puede guardar. Se
 * hace antes de mover, porque después el contenido ya no existe; una
 * descripción que ya lo lleva —un reintento tras un fallo— no se vuelve a
 * tocar.
 */
async function preserveLostFields(
    client: AxiosInstance,
    issues: PlannedIssue[],
    target: string,
    notify: boolean,
): Promise<{ updated: string[]; failed?: { key: string; error: string } }> {
    const updated: string[] = [];

    for (const issue of issues) {
        const fields = issue.lostFields.filter((field) => field.id !== 'description');

        if (fields.length === 0 || alreadyPreserved(issue.raw.fields.description)) {
            continue;
        }

        const current = isAdfDocument(issue.raw.fields.description)
            ? (issue.raw.fields.description as AdfDocument)
            : undefined;

        const description: AdfDocument = {
            type: 'doc',
            version: 1,
            content: [...(current?.content ?? []), ...preservedSection(issue, target)],
        };

        try {
            await client.put(
                `/rest/api/3/issue/${issue.id}`,
                { fields: { description } },
                { params: { notifyUsers: notify } },
            );
        } catch (error) {
            try {
                handleJiraError(error);
            } catch (explained) {
                return {
                    updated,
                    failed: {
                        key: issue.key,
                        error: explained instanceof Error ? explained.message : String(explained),
                    },
                };
            }
        }

        updated.push(issue.key);
    }

    return { updated };
}

function buildPayload(batch: PlannedIssue[], target: TargetProject, notify: boolean) {
    const groups = new Map<string, { ids: string[]; statuses: Map<string, Set<string>> }>();

    for (const issue of batch) {
        const key = mappingKey(issue, target);

        const group = groups.get(key) ?? {
            ids: [] as string[],
            statuses: new Map<string, Set<string>>(),
        };

        group.ids.push(issue.id);

        if (issue.statusNeedsMapping && issue.targetStatus) {
            const sources = group.statuses.get(issue.targetStatus.id) ?? new Set<string>();

            sources.add(issue.sourceStatus.id);
            group.statuses.set(issue.targetStatus.id, sources);
        }

        groups.set(key, group);
    }

    return {
        sendBulkNotification: notify,
        targetToSourcesMapping: Object.fromEntries(
            [...groups].map(([key, group]) => [
                key,
                {
                    inferClassificationDefaults: true,
                    inferFieldDefaults: true,
                    inferStatusDefaults: false,
                    inferSubtaskTypeDefault: false,
                    issueIdsOrKeys: group.ids,
                    ...(group.statuses.size > 0 && {
                        targetStatus: [
                            {
                                statuses: Object.fromEntries(
                                    [...group.statuses].map(([to, from]) => [to, [...from]]),
                                ),
                            },
                        ],
                    }),
                },
            ]),
        ),
    };
}

interface TaskResult {
    phase: number;
    taskId?: string;
    status: string;
    progressPercent?: number;
    issues: number;
    error?: string;
    processed: Set<string>;
    failed: Map<string, string[]>;
}

const TERMINAL = new Set(['COMPLETE', 'FAILED', 'CANCELLED', 'DEAD']);

async function runBatch(
    client: AxiosInstance,
    batch: PlannedIssue[],
    phase: number,
    plan: Plan,
    notify: boolean,
    deadline: number,
    progress: MoveProgress,
    done: number,
    total: number,
): Promise<TaskResult> {
    const result: TaskResult = {
        phase,
        status: 'NOT_SUBMITTED',
        issues: batch.length,
        processed: new Set(),
        failed: new Map(),
    };

    try {
        const response = await client.post<{ taskId: string }>(
            '/rest/api/3/bulk/issues/move',
            buildPayload(batch, plan.target, notify),
        );

        result.taskId = response.data.taskId;
        result.status = 'ENQUEUED';
    } catch (error) {
        try {
            handleJiraError(error);
        } catch (explained) {
            result.error = explained instanceof Error ? explained.message : String(explained);
        }

        return result;
    }

    for (;;) {
        if (Date.now() > deadline) {
            result.status = 'TIMED_OUT';
            result.error = `Se agotó el tiempo de espera con la tarea ${result.taskId} en curso. Puede seguir moviéndose en Jira: repetir el plan dice qué quedó dónde.`;

            return result;
        }

        await sleep(POLL_INTERVAL_MS);

        try {
            const response = await client.get<{
                status: string;
                progressPercent?: number;
                processedAccessibleIssues?: number[];
                failedAccessibleIssues?: Record<string, string[]>;
            }>(`/rest/api/3/bulk/queue/${result.taskId}`);

            const task = response.data;

            result.status = task.status;
            result.progressPercent = task.progressPercent;

            await progress(
                `Fase ${phase}: tarea ${result.taskId} ${task.status} ${task.progressPercent ?? 0}%`,
                done + Math.round(((task.progressPercent ?? 0) / 100) * batch.length),
                total,
            );

            if (TERMINAL.has(task.status)) {
                for (const id of task.processedAccessibleIssues ?? []) {
                    result.processed.add(String(id));
                }

                for (const [id, reasons] of Object.entries(task.failedAccessibleIssues ?? {})) {
                    result.failed.set(id, reasons);
                }

                return result;
            }
        } catch (error) {
            // Una consulta de progreso que falla no dice nada de la tarea:
            // se reintenta hasta el tiempo máximo.
            await progress(
                `Fase ${phase}: no se pudo leer el progreso de ${result.taskId}; se reintenta`,
                done,
                total,
            );
        }
    }
}

async function verify(
    client: AxiosInstance,
    issues: PlannedIssue[],
    target: TargetProject,
) {
    const { issues: current } = await fetchIssues(
        client,
        issues.map((issue) => issue.id),
    );

    const byId = new Map(current.map((issue) => [issue.id, issue]));

    return issues.map((issue) => {
        const now = byId.get(issue.id);

        if (!now) {
            return { issue, newKey: undefined, problems: ['No se pudo releer.'] };
        }

        const problems: string[] = [];

        if (now.fields.project.key !== target.key) {
            problems.push(`Sigue en ${now.fields.project.key}.`);
        }

        if (issue.targetType && now.fields.issuetype.id !== issue.targetType.id) {
            problems.push(`El tipo es ${now.fields.issuetype.name}, no ${issue.targetType.name}.`);
        }

        if (issue.targetStatus && now.fields.status.id !== issue.targetStatus.id) {
            problems.push(`El estado es ${now.fields.status.name}, no ${issue.targetStatus.name}.`);
        }

        if ((now.fields.parent?.id ?? null) !== (issue.parent?.id ?? null)) {
            problems.push(
                `El padre es ${now.fields.parent?.key ?? 'ninguno'}, no ${issue.parent?.key ?? 'ninguno'}.`,
            );
        }

        return { issue, newKey: now.key, problems };
    });
}

async function execute(
    client: AxiosInstance,
    input: MoveIssuesInput,
    progress: MoveProgress,
) {
    if (!input.planId) {
        return {
            mode: 'execute',
            outcome: 'refused',
            message:
                'No se ha movido nada: execute necesita el planId de un plan previo con la misma entrada. Pedir mode: "plan", revisarlo y repetir con su planId.',
        };
    }

    const issuedAt = issuedPlans.get(input.planId);

    if (issuedAt === undefined || Date.now() - issuedAt > PLAN_TTL_MS) {
        return {
            mode: 'execute',
            outcome: 'refused',
            message:
                `No se ha movido nada: el plan ${input.planId} no lo emitió este servidor o caducó (dura ${PLAN_TTL_MS / 60000} minutos y no sobrevive a un reinicio de la sesión). Repetir el plan.`,
        };
    }

    await progress('Repitiendo las comprobaciones del plan', 0);

    const plan = await buildPlan(client, input);

    if (plan.blockers.length > 0) {
        return {
            mode: 'execute',
            outcome: 'blocked',
            message: 'No se ha movido nada: al repetir las comprobaciones hay bloqueos.',
            ...summarizePlan(plan),
        };
    }

    if (plan.planId !== input.planId) {
        return {
            mode: 'execute',
            outcome: 'refused',
            message:
                'No se ha movido nada: la entrada o los issues han cambiado desde el plan (otra entrada, un estado distinto, un hijo nuevo). Repetir el plan y revisarlo.',
        };
    }

    issuedPlans.delete(input.planId);

    const notify = input.notify ?? false;

    const toMove = plan.issues.filter((issue) => !issue.alreadyInTarget);

    const total = toMove.length;

    const timeline: string[] = [];

    const report: MoveProgress = async (message, done, all) => {
        timeline.push(message);
        await progress(message, done, all);
    };

    let descriptionsUpdated: string[] = [];

    if (input.preserveLostFields ?? true) {
        await report('Conservando en la descripción los campos que se perderían', 0, total);

        const preserved = await preserveLostFields(client, toMove, plan.target.key, notify);

        descriptionsUpdated = preserved.updated;

        if (preserved.failed) {
            return {
                mode: 'execute',
                outcome: 'nothing-moved',
                message: `No se ha movido nada: no se pudo escribir la descripción de ${preserved.failed.key} (${preserved.failed.error}).`,
                descriptionsUpdated,
                ...(descriptionsUpdated.length > 0 && {
                    note: 'Estas descripciones ya llevan añadido el contenido de los campos; un reintento no lo duplica.',
                }),
            };
        }
    }

    const deadline =
        Date.now() + Math.min(input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, 1800) * 1000;

    const tasks: TaskResult[] = [];

    let done = 0;

    let stopped: string | undefined;

    phases: for (const [index, batches] of plan.phases.entries()) {
        for (const batch of batches) {
            await report(`Fase ${index + 1}: enviando ${batch.length} issues`, done, total);

            const task = await runBatch(
                client,
                batch,
                index + 1,
                plan,
                notify,
                deadline,
                report,
                done,
                total,
            );

            tasks.push(task);
            done += batch.length;

            const incomplete =
                task.status !== 'COMPLETE' ||
                task.failed.size > 0 ||
                task.processed.size < batch.length;

            if (incomplete) {
                stopped = `La fase ${index + 1} no terminó entera (${task.status}${task.error ? `: ${task.error}` : ''}); no se enviaron las siguientes para no separar a los hijos de sus padres.`;
                break phases;
            }
        }
    }

    await report('Verificando los issues movidos', done, total);

    const checked = await verify(client, toMove, plan.target);

    const failedReasons = new Map<string, string[]>();

    for (const task of tasks) {
        for (const [id, reasons] of task.failed) {
            failedReasons.set(id, reasons);
        }
    }

    const moved = checked
        .filter((entry) => entry.newKey !== undefined && entry.newKey !== entry.issue.key)
        .map((entry) => ({
            from: entry.issue.key,
            to: entry.newKey!,
            ...(entry.problems.length > 0 ? { problems: entry.problems } : { verified: true }),
        }));

    const movedKeys = new Set(moved.map((entry) => entry.from));

    const notMoved = checked
        .filter((entry) => !movedKeys.has(entry.issue.key))
        .map((entry) => ({
            key: entry.issue.key,
            reason:
                failedReasons.get(entry.issue.id)?.join(' ') ??
                (entry.problems.length > 0 && entry.newKey !== undefined
                    ? entry.problems.join(' ')
                    : 'No llegó a enviarse o Jira no lo procesó.'),
        }));

    const withProblems = moved.filter((entry) => 'problems' in entry).length;

    const outcome =
        notMoved.length === 0 && withProblems === 0
            ? 'moved'
            : moved.length === 0
              ? 'nothing-moved'
              : 'partial';

    const message =
        outcome === 'moved'
            ? `Movidos y verificados ${moved.length} issues a ${plan.target.key}.`
            : outcome === 'nothing-moved'
              ? `No se ha movido ningún issue a ${plan.target.key}.`
              : `Movimiento incompleto: ${moved.length} de ${total} issues están en ${plan.target.key}${withProblems > 0 ? `, ${withProblems} con diferencias respecto al plan` : ''}, y ${notMoved.length} no se movieron. Jira no deshace lo movido.`;

    return {
        mode: 'execute',
        outcome,
        message,
        ...(stopped && { stopped }),
        moved,
        ...(notMoved.length > 0 && { notMoved }),
        ...(descriptionsUpdated.length > 0 && { descriptionsUpdated }),
        tasks: tasks.map(({ processed, failed, ...task }) => ({
            ...task,
            processed: processed.size,
            failed: failed.size,
        })),
        progress: timeline,
    };
}

export async function moveIssues(
    input: MoveIssuesInput,
    progress: MoveProgress = async () => {},
) {
    try {
        const client = createJiraClient();

        if ((input.mode ?? 'plan') === 'execute') {
            return await execute(client, input, progress);
        }

        const plan = await buildPlan(client, input);

        if (plan.planId) {
            issuedPlans.set(plan.planId, Date.now());
        }

        return {
            mode: 'plan',
            ...(plan.planId
                ? {
                      planId: plan.planId,
                      nextStep: `Sin bloqueos. Para mover, repetir la llamada con la misma entrada, mode: "execute" y planId: "${plan.planId}" (válido ${PLAN_TTL_MS / 60000} minutos, en esta sesión).`,
                  }
                : {
                      nextStep:
                          plan.blockers.length > 0
                              ? 'Hay bloqueos: resolverlos y repetir el plan. execute no moverá nada mientras los haya.'
                              : 'No hay nada que mover.',
                  }),
            ...summarizePlan(plan),
        };
    } catch (error) {
        handleJiraError(error);
    }
}
