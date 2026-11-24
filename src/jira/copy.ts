import { createHash, randomUUID } from 'node:crypto';

import type { AxiosInstance } from 'axios';

import { adfToMarkdown, isAdfDocument } from './adf.js';
import { createJiraClient } from './client.js';
import { handleJiraError } from './error.js';
import { readFieldValue } from './fields.js';
import { markdownToAdf } from './markdown.js';
import { getAllFields } from './meta.js';
import {
    MACHINE_FIELD_TYPES,
    PROJECT_SCOPED,
    chunk,
    collectIssues,
    fetchIssues,
    fetchTargetProject,
    fetchTargetStatuses,
    hasPermissions,
    isEmpty,
    lookup,
    resolveType,
    toText,
} from './move.js';
import { normalizeName } from './names.js';

import type { AdfDocument, AdfNode } from './adf.js';
import type {
    Blocker,
    MoveProgress,
    RawIssue,
    TargetIssueType,
    TargetProject,
} from './move.js';

import type { JiraFieldSpec } from '../types/jira.js';

/**
 * Copiar issues a otro proyecto de la misma instancia sin tocar los originales.
 *
 * Jira no tiene una API de copia: cada copia es un alta nueva, y todo lo que
 * no es un campo —el estado, los comentarios, los adjuntos, el tiempo, los
 * enlaces— se reproduce después con su propia petición. Por eso la copia va
 * en dos tramos:
 *
 * 1. Altas por profundidad: las épicas, después sus hijos con la copia de la
 *    épica como padre, después las subtareas. Cada copia se enlaza a su
 *    original nada más crearse, porque ese enlace es lo que permite
 *    reconocerla si hay que repetir: un fallo detiene las fases siguientes y
 *    el plan siguiente continúa desde ahí.
 * 2. Por cada copia, lo que no viaja en el alta. Cada paso mira antes qué hay
 *    ya en la copia, así que repetirlo no duplica nada.
 *
 * Igual que al mover, nada se adivina: un tipo o un estado sin equivalente, o
 * un campo obligatorio que quedaría vacío, es un bloqueo.
 */

export type CopyExtra = 'comments' | 'attachments' | 'labels' | 'assignee' | 'worklogs';

export interface CopyIssuesInput {
    issueKeys: string[];
    targetProject: string;
    includeChildren?: boolean;
    mode?: 'plan' | 'execute';
    planId?: string;
    typeMapping?: Record<string, string>;
    statusMapping?: Record<string, string>;
    targetStatus?: string;
    copy?: CopyExtra[];
    linkToOriginal?: boolean;
    summaryPrefix?: string;
    preserveLostFields?: boolean;
    notify?: boolean;
    timeoutSeconds?: number;
}

export interface CreateFieldMeta {
    id: string;
    name: string;
    required: boolean;
    hasDefaultValue: boolean;
    schema?: { type?: string; items?: string; custom?: string; system?: string };
    allowedValues?: Array<Record<string, unknown>>;
}

interface LostField {
    id: string;
    name: string;
    value: string;
    /** Si el campo es texto rico, su contenido tal cual, para no pasarlo por markdown. */
    adf?: AdfNode[];
    reason: string;
    sameNameInTarget?: string;
}

interface StatusRef {
    id: string;
    name: string;
}

interface LinkType {
    id: string;
    name: string;
    inward: string;
    outward: string;
}

interface RawLink {
    id: string;
    type: { id?: string; name: string; inward?: string; outward?: string };
    inwardIssue?: { id: string; key: string };
    outwardIssue?: { id: string; key: string };
}

interface CopyRef {
    id: string;
    key: string;
}

interface PlannedCopy {
    raw: RawIssue;
    key: string;
    id: string;
    /** Resumen de la copia, con el prefijo. */
    summary: string;
    sourceType: StatusRef;
    sourceStatus: StatusRef;
    targetType?: TargetIssueType;
    targetStatus?: StatusRef;
    /** Estados por los que pasar hasta el pedido, si se pudo leer el flujo. */
    path?: StatusRef[];
    /** El flujo se leyó y no lleva al estado pedido: no se intenta. */
    noPath?: boolean;
    initialStatus?: StatusRef;
    parent?: CopyRef;
    /** Padre de la copia: la copia de otro del lote, o un issue que ya está en el destino. */
    copyParent?:
        | { kind: 'batch'; originalId: string; originalKey: string }
        | { kind: 'existing'; key: string };
    subtask: boolean;
    phase: number;
    /** Lo que viaja en el alta, ya en el formato de escritura. */
    fields: Record<string, unknown>;
    lostFields: LostField[];
    /** Copia hecha en una ejecución anterior, reconocida por su enlace. */
    existingCopy?: CopyRef & { status: StatusRef; parentKey?: string };
    extras: { comments: number; attachments: number; attachmentBytes: number; worklogs: number; links: number };
}

interface Plan {
    planId?: string;
    target: TargetProject;
    cloneType?: LinkType;
    issues: PlannedCopy[];
    blockers: Blocker[];
    warnings: string[];
    phases: PlannedCopy[][];
}

/** Lo que admite la API de alta masiva en una petición. */
const BULK_CREATE_LIMIT = 50;
const PLAN_TTL_MS = 30 * 60 * 1000;
const DEFAULT_TIMEOUT_SECONDS = 300;
const LISTED_ISSUES = 200;
const SUMMARY_MAX = 255;

/** Título con que se marca lo añadido a la descripción de la copia. */
const PRESERVED_HEADING = 'Campos del original que el destino no admite';

/** Campos de sistema que se copian; el resto los pone o los calcula Jira. */
const COPYABLE_SYSTEM = new Set([
    'description',
    'environment',
    'duedate',
    'priority',
    'timetracking',
    'labels',
    'assignee',
    'security',
]);

/** Campos que el alta pone por su cuenta, no desde el original. */
const SET_BY_COPY = new Set(['project', 'issuetype', 'summary', 'parent', 'reporter']);

/**
 * Lo que cambia en el original sin que cambie su contenido: el enlace a la
 * copia, la fecha de modificación que ese enlace mueve y lo que depende de
 * quien lo mira. Se excluye al comprobar que los originales no han cambiado.
 */
const VOLATILE = new Set(['issuelinks', 'updated', 'lastViewed', 'watches', 'votes']);

const issuedPlans = new Map<string, number>();

// --- Valores --------------------------------------------------------------

/** Copia un valor ADF con todas las casillas sin marcar. */
export function resetTasks<T>(value: T): T {
    if (Array.isArray(value)) {
        return value.map(resetTasks) as T;
    }

    if (value === null || typeof value !== 'object') {
        return value;
    }

    const node = value as Record<string, unknown>;

    const copy: Record<string, unknown> = {};

    for (const [key, child] of Object.entries(node)) {
        copy[key] = resetTasks(child);
    }

    if (node.type === 'taskItem') {
        copy.attrs = { ...((copy.attrs as object | undefined) ?? {}), state: 'TODO' };
    }

    return copy as T;
}

/** Casillas de un documento ADF: cuántas hay y cuántas sin marcar. */
export function countTasks(value: unknown): { total: number; todo: number } {
    const count = { total: 0, todo: 0 };

    const walk = (node: unknown): void => {
        if (Array.isArray(node)) {
            node.forEach(walk);
            return;
        }

        if (node === null || typeof node !== 'object') {
            return;
        }

        const object = node as AdfNode;

        if (object.type === 'taskItem') {
            count.total += 1;

            if (object.attrs?.state !== 'DONE') {
                count.todo += 1;
            }
        }

        walk(object.content);
    };

    walk(value);

    return count;
}

function hasMedia(value: unknown): boolean {
    if (Array.isArray(value)) {
        return value.some(hasMedia);
    }

    if (value === null || typeof value !== 'object') {
        return false;
    }

    const node = value as AdfNode;

    return node.type === 'media' || hasMedia(node.content);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function labelOf(option: Record<string, unknown>): string | undefined {
    const text = option.value ?? option.name;

    return typeof text === 'string' ? text : undefined;
}

/**
 * Busca entre los valores que admite el destino el que corresponde al del
 * original: primero por identificador —el mismo contexto del campo comparte
 * opciones— y después por su texto.
 */
function matchAllowed(
    allowed: Array<Record<string, unknown>>,
    value: Record<string, unknown>,
): Record<string, unknown> | undefined {
    const byId = allowed.find((candidate) => value.id !== undefined && candidate.id === value.id);

    if (byId) {
        return byId;
    }

    const text = labelOf(value);

    if (text === undefined) {
        return undefined;
    }

    return allowed.find((candidate) => {
        const other = labelOf(candidate);

        return other !== undefined && normalizeName(other) === normalizeName(text);
    });
}

function writeOption(meta: CreateFieldMeta, value: unknown): Record<string, unknown> | undefined {
    const object = asObject(value);

    if (!object) {
        return undefined;
    }

    if (!meta.allowedValues) {
        return typeof object.id === 'string' ? { id: object.id } : undefined;
    }

    const hit = matchAllowed(meta.allowedValues, object);

    return typeof hit?.id === 'string' ? { id: hit.id } : undefined;
}

function writeUser(value: unknown): Record<string, unknown> | undefined {
    const object = asObject(value);

    return typeof object?.accountId === 'string' ? { accountId: object.accountId } : undefined;
}

function writeGroup(value: unknown): Record<string, unknown> | undefined {
    const object = asObject(value);

    if (typeof object?.groupId === 'string') {
        return { groupId: object.groupId };
    }

    return typeof object?.name === 'string' ? { name: object.name } : undefined;
}

export type Writable = { value: unknown } | { reason: string };

/**
 * Traduce el valor leído del original a lo que admite el alta. Jira lee y
 * escribe formas distintas —una opción vuelve con su texto y su enlace, y se
 * escribe por identificador—, y una opción del original puede no existir en
 * el contexto del campo en el destino: entonces no se copia y se dice por qué.
 * El ADF viaja tal cual, con las casillas sin marcar.
 */
export function toWritable(value: unknown, meta: CreateFieldMeta): Writable {
    const type = meta.schema?.type;
    const items = meta.schema?.items;
    const custom = meta.schema?.custom?.split(':').pop() ?? '';

    if (isAdfDocument(value)) {
        return { value: resetTasks(value) };
    }

    if (custom === 'atlassian-team') {
        const object = asObject(value);

        return typeof object?.id === 'string'
            ? { value: object.id }
            : { reason: 'el equipo no trae un identificador legible' };
    }

    const notAllowed = (shown: unknown): Writable => ({
        reason: `«${toText(shown)}» no es un valor admitido en el destino`,
    });

    switch (type) {
        case 'string':
        case 'number':
        case 'date':
        case 'datetime':
            return typeof value === 'object' ? { reason: 'formato no reconocido' } : { value };
        case 'option':
        case 'priority':
        case 'securitylevel': {
            const written = writeOption(meta, value);

            return written ? { value: written } : notAllowed(value);
        }
        case 'option-with-child': {
            const object = asObject(value);

            if (!object) {
                return { reason: 'formato no reconocido' };
            }

            const parent = meta.allowedValues ? matchAllowed(meta.allowedValues, object) : object;

            if (typeof parent?.id !== 'string') {
                return notAllowed(value);
            }

            const child = asObject(object.child);

            if (!child) {
                return { value: { id: parent.id } };
            }

            const children = Array.isArray(parent.children)
                ? (parent.children as Array<Record<string, unknown>>)
                : undefined;

            const childHit = children ? matchAllowed(children, child) : child;

            return typeof childHit?.id === 'string'
                ? { value: { id: parent.id, child: { id: childHit.id } } }
                : notAllowed(`${toText(object)} > ${toText(child)}`);
        }
        case 'user': {
            const written = writeUser(value);

            return written ? { value: written } : { reason: 'formato de usuario no reconocido' };
        }
        case 'group': {
            const written = writeGroup(value);

            return written ? { value: written } : { reason: 'formato de grupo no reconocido' };
        }
        case 'timetracking': {
            const estimate = asObject(value)?.originalEstimate;

            return typeof estimate === 'string'
                ? { value: { originalEstimate: estimate } }
                : { reason: 'sin estimación original' };
        }
        case 'array': {
            if (!Array.isArray(value)) {
                return { reason: 'formato no reconocido' };
            }

            if (items === 'string') {
                return value.every((item) => typeof item === 'string')
                    ? { value }
                    : { reason: 'formato no reconocido' };
            }

            const writer =
                items === 'option'
                    ? (item: unknown) => writeOption(meta, item)
                    : items === 'user'
                      ? writeUser
                      : items === 'group'
                        ? writeGroup
                        : undefined;

            if (!writer) {
                return { reason: `las listas de tipo «${items ?? '?'}» no se copian` };
            }

            const written = value.map(writer);

            const missing = value.filter((_, index) => written[index] === undefined);

            return missing.length === 0 ? { value: written } : notAllowed(missing);
        }
        default:
            return value === null || typeof value !== 'object'
                ? { value }
                : { reason: `los campos de tipo «${type ?? custom}» no se copian` };
    }
}

/** Forma comparable de un valor, para verificar lo que quedó en la copia. */
export function comparable(value: unknown): string {
    if (value === null || value === undefined) {
        return '';
    }

    if (isAdfDocument(value)) {
        return (adfToMarkdown(value) ?? '').trim();
    }

    if (Array.isArray(value)) {
        return value.map(comparable).sort().join('|');
    }

    if (typeof value === 'object') {
        const object = value as Record<string, unknown>;

        const head =
            object.accountId ??
            object.id ??
            object.groupId ??
            object.name ??
            object.value ??
            object.originalEstimate;

        const child = object.child === undefined ? '' : `>${comparable(object.child)}`;

        return head === undefined ? JSON.stringify(value) : `${String(head)}${child}`;
    }

    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
        const time = Date.parse(value);

        return Number.isNaN(time) ? value : new Date(time).toISOString();
    }

    return String(value);
}

/** Proyecto de una clave: lo que va antes del último guion. */
function projectOf(key: string): string {
    return key.slice(0, key.lastIndexOf('-')).toUpperCase();
}

function explain(error: unknown): string {
    try {
        handleJiraError(error);
    } catch (explained) {
        return explained instanceof Error ? explained.message : String(explained);
    }
}

function issueLinks(issue: RawIssue): RawLink[] {
    return (issue.fields.issuelinks as RawLink[] | undefined) ?? [];
}

interface Attachment {
    id: string;
    filename: string;
    size: number;
    mimeType?: string;
}

function issueAttachments(issue: RawIssue): Attachment[] {
    return (issue.fields.attachment as Attachment[] | undefined) ?? [];
}

function totalOf(value: unknown): number {
    const total = asObject(value)?.total;

    return typeof total === 'number' ? total : 0;
}

// --- Lecturas -------------------------------------------------------------

async function fetchCreateMeta(
    client: AxiosInstance,
    projectKey: string,
    issueTypeId: string,
): Promise<CreateFieldMeta[]> {
    const fields: CreateFieldMeta[] = [];

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
                schema?: CreateFieldMeta['schema'];
                allowedValues?: Array<Record<string, unknown>>;
            }>;
        }>(`/rest/api/3/issue/createmeta/${projectKey}/issuetypes/${issueTypeId}`, {
            params: { startAt, maxResults: 100 },
        });

        const page = response.data.fields;

        fields.push(
            ...page.map((field) => ({
                id: field.fieldId ?? field.key ?? '',
                name: field.name,
                required: field.required,
                hasDefaultValue: field.hasDefaultValue ?? false,
                ...(field.schema && { schema: field.schema }),
                ...(field.allowedValues && { allowedValues: field.allowedValues }),
            })),
        );

        startAt += page.length;

        if (page.length === 0 || startAt >= response.data.total) {
            break;
        }
    }

    return fields;
}

/** «Cloners» si la instancia lo tiene; si no, «Relates». */
function findCloneType(types: LinkType[]): LinkType | undefined {
    const is = (type: LinkType, ...names: string[]) =>
        names.some(
            (name) =>
                normalizeName(type.name) === normalizeName(name) ||
                normalizeName(type.outward) === normalizeName(name),
        );

    return (
        types.find((type) => is(type, 'Cloners', 'clones')) ??
        types.find((type) => is(type, 'Relates', 'relates to'))
    );
}

export interface WorkflowGraph {
    initial: string;
    /** Estado de origen → estados a los que lleva; '*' son las transiciones globales. */
    edges: Map<string, string[]>;
}

/**
 * Lee el flujo de un tipo en el destino para saber de qué estado nace una
 * copia y si se llega al pedido. La API exige administrar Jira o el proyecto;
 * sin ese permiso, o ante una respuesta que no se entiende, devuelve undefined
 * y el camino se comprueba al ejecutar.
 */
async function fetchWorkflowGraph(
    client: AxiosInstance,
    projectId: string,
    issueTypeId: string,
    valid: StatusRef[],
): Promise<WorkflowGraph | undefined> {
    try {
        const response = await client.post<{
            statuses?: Array<{ id?: string; statusReference?: string }>;
            workflows?: Array<{
                transitions?: Array<{
                    type?: string;
                    toStatusReference?: string;
                    links?: Array<{ fromStatusReference?: string }>;
                }>;
            }>;
        }>('/rest/api/3/workflows', { projectAndIssueTypes: [{ projectId, issueTypeId }] });

        const workflow = response.data.workflows?.[0];

        if (!workflow?.transitions) {
            return undefined;
        }

        const references = new Map<string, string>();

        for (const status of response.data.statuses ?? []) {
            if (status.statusReference && status.id) {
                references.set(status.statusReference, status.id);
            }
        }

        const toId = (reference?: string) =>
            reference === undefined ? undefined : (references.get(reference) ?? reference);

        const edges = new Map<string, string[]>();

        let initial: string | undefined;

        for (const transition of workflow.transitions) {
            const to = toId(transition.toStatusReference);

            if (to === undefined) {
                continue;
            }

            if (transition.type === 'INITIAL') {
                initial = to;
                continue;
            }

            const sources =
                transition.type === 'GLOBAL'
                    ? ['*']
                    : (transition.links ?? [])
                          .map((link) => toId(link.fromStatusReference))
                          .filter((from): from is string => from !== undefined);

            for (const from of sources) {
                edges.set(from, [...(edges.get(from) ?? []), to]);
            }
        }

        // Un estado inicial que no es de este tipo delata que las referencias
        // no son identificadores de estado: mejor no fiarse del flujo.
        if (initial === undefined || !valid.some((status) => status.id === initial)) {
            return undefined;
        }

        return { initial, edges };
    } catch {
        return undefined;
    }
}

/** Camino más corto entre dos estados, sin el de partida; [] si ya está. */
export function findPath(graph: WorkflowGraph, from: string, to: string): string[] | undefined {
    if (from === to) {
        return [];
    }

    const previous = new Map<string, string>([[from, from]]);

    const queue = [from];

    while (queue.length > 0) {
        const current = queue.shift()!;

        for (const next of [...(graph.edges.get(current) ?? []), ...(graph.edges.get('*') ?? [])]) {
            if (previous.has(next)) {
                continue;
            }

            previous.set(next, current);

            if (next === to) {
                const path = [to];

                for (let step = current; step !== from; step = previous.get(step)!) {
                    path.unshift(step);
                }

                return path;
            }

            queue.push(next);
        }
    }

    return undefined;
}

async function isAssignable(client: AxiosInstance, project: string, accountId: string): Promise<boolean> {
    try {
        const response = await client.get<Array<{ accountId: string }>>(
            '/rest/api/3/user/assignable/search',
            { params: { project, accountId } },
        );

        return response.data.some((user) => user.accountId === accountId);
    } catch {
        return false;
    }
}

/**
 * Copias ya hechas de cada original: issues del destino que lo clonan y se
 * llaman como se llamaría la copia. El resumen descarta un «relates to» que ya
 * hubiera hacia el destino y no fuese una copia.
 */
async function findExistingCopies(
    client: AxiosInstance,
    issues: PlannedCopy[],
    target: TargetProject,
    cloneType: LinkType,
    warnings: Set<string>,
): Promise<void> {
    const candidates = new Map<string, string[]>();

    for (const issue of issues) {
        // En el original, el enlace con su copia trae la copia en inwardIssue:
        // «copia clones original».
        const keys = issueLinks(issue.raw)
            .filter((link) => link.type.name === cloneType.name && link.inwardIssue)
            .map((link) => link.inwardIssue!.key)
            .filter((key) => projectOf(key) === target.key);

        if (keys.length > 0) {
            candidates.set(issue.id, keys);
        }
    }

    const all = [...new Set([...candidates.values()].flat())];

    if (all.length === 0) {
        return;
    }

    const { issues: found } = await fetchIssues(client, all);

    const byKey = new Map(found.map((issue) => [issue.key.toUpperCase(), issue]));

    for (const issue of issues) {
        const matches = (candidates.get(issue.id) ?? [])
            .map((key) => byKey.get(key.toUpperCase()))
            .filter((copy): copy is RawIssue => copy !== undefined)
            .filter(
                (copy) =>
                    copy.fields.summary === issue.summary &&
                    (!issue.targetType || copy.fields.issuetype.id === issue.targetType.id),
            );

        if (matches.length === 0) {
            continue;
        }

        const [copy] = matches;

        issue.existingCopy = {
            id: copy.id,
            key: copy.key,
            status: { id: copy.fields.status.id, name: copy.fields.status.name },
            ...(copy.fields.parent && { parentKey: copy.fields.parent.key }),
        };

        if (matches.length > 1) {
            warnings.add(
                `${issue.key} tiene varias copias en ${target.key} (${matches.map((match) => match.key).join(', ')}): se toma ${copy.key} y se completa esa.`,
            );
        }
    }
}

// --- Plan -----------------------------------------------------------------

function resolveCopyStatus(
    issue: RawIssue,
    type: TargetIssueType,
    statuses: Map<string, StatusRef[]>,
    input: CopyIssuesInput,
    target: string,
): { status?: StatusRef; blocker?: string } {
    const valid = statuses.get(type.id) ?? [];

    const available = valid.map((status) => status.name).join(', ');

    const find = (wanted: string) =>
        valid.find(
            (candidate) =>
                candidate.id === wanted.trim() ||
                normalizeName(candidate.name) === normalizeName(wanted),
        );

    if (input.targetStatus !== undefined) {
        const status = find(input.targetStatus);

        return status
            ? { status }
            : {
                  blocker: `targetStatus "${input.targetStatus}" no es un estado de ${type.name} en ${target}. Estados posibles: ${available}.`,
              };
    }

    const source = issue.fields.status;

    const mapped = lookup(input.statusMapping, source.name, source.id);

    if (mapped !== undefined) {
        const status = find(mapped);

        return status
            ? { status }
            : {
                  blocker: `statusMapping lleva "${source.name}" a "${mapped}", que no es un estado de ${type.name} en ${target}. Estados posibles: ${available}.`,
              };
    }

    const same = valid.find((candidate) => candidate.id === source.id) ?? find(source.name);

    return same
        ? { status: same }
        : {
              blocker: `El estado "${source.name}" no existe para ${type.name} en ${target}. Indicar su equivalente en statusMapping, o un estado para todas las copias en targetStatus. Estados posibles: ${available}.`,
          };
}

/**
 * Decide qué campos del original viajan en el alta y cuáles se pierden. Se
 * comparan por identificador: un campo del destino que se llama igual pero es
 * otro no recibe el contenido.
 */
export function planFields(
    issue: RawIssue,
    createMeta: CreateFieldMeta[],
    catalog: Map<string, JiraFieldSpec>,
    extras: Set<CopyExtra>,
): { fields: Record<string, unknown>; lost: LostField[] } {
    const byId = new Map(createMeta.map((field) => [field.id, field]));

    const fields: Record<string, unknown> = {};

    const lost: LostField[] = [];

    for (const [id, value] of Object.entries(issue.fields)) {
        if (isEmpty(value)) {
            continue;
        }

        const custom = id.startsWith('customfield_');

        if (!custom && !COPYABLE_SYSTEM.has(id) && !PROJECT_SCOPED.has(id)) {
            continue;
        }

        // Lo que no se pide copiar no se pierde: se deja fuera a propósito.
        if ((id === 'labels' && !extras.has('labels')) || (id === 'assignee' && !extras.has('assignee'))) {
            continue;
        }

        if (id === 'timetracking' && typeof asObject(value)?.originalEstimate !== 'string') {
            continue;
        }

        const spec = catalog.get(id);

        // El nombre de épica clásico sí es contenido, y hay destinos que lo exigen.
        if (custom && spec?.custom && MACHINE_FIELD_TYPES.has(spec.custom) && spec.custom !== 'gh-epic-label') {
            continue;
        }

        const name = spec?.name ?? id;

        const lose = (reason: string) => {
            const twin = createMeta.find(
                (field) => field.id !== id && normalizeName(field.name) === normalizeName(name),
            );

            const estimate = id === 'timetracking' ? asObject(value)?.originalEstimate : undefined;

            lost.push({
                id,
                name,
                value:
                    typeof estimate === 'string'
                        ? `Estimación original: ${estimate}`
                        : toText(readFieldValue(value)),
                ...(isAdfDocument(value) && { adf: resetTasks((value as AdfDocument).content) }),
                reason,
                ...(twin && { sameNameInTarget: twin.id }),
            });
        };

        if (spec?.custom === 'gh-sprint') {
            lose('el sprint es del tablero de origen');
            continue;
        }

        if (PROJECT_SCOPED.has(id)) {
            lose('sus valores son del proyecto de origen');
            continue;
        }

        const meta = byId.get(id);

        if (!meta) {
            lose('el destino no tiene este campo al crear este tipo');
            continue;
        }

        const written = toWritable(value, meta);

        if ('reason' in written) {
            lose(written.reason);
            continue;
        }

        fields[id] = written.value;
    }

    return { fields, lost };
}

function preservedSection(issue: PlannedCopy, target: string): AdfNode[] {
    const nodes: AdfNode[] = [
        { type: 'rule' },
        {
            type: 'heading',
            attrs: { level: 2 },
            content: [{ type: 'text', text: `${PRESERVED_HEADING} (${issue.key} → ${target})` }],
        },
    ];

    for (const field of issue.lostFields) {
        if (field.id === 'description') {
            continue;
        }

        nodes.push({ type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: field.name }] });
        // El texto rico viaja tal cual, con las casillas sin marcar, como el
        // resto de la copia: pasarlo por markdown aplanaría lo que no traduce.
        nodes.push(...(field.adf ?? resetTasks(markdownToAdf(field.value).content)));
    }

    return nodes;
}

/** Profundidad de cada alta: una copia se crea en la fase siguiente a la de su padre. */
function assignPhases(issues: PlannedCopy[]): void {
    const byId = new Map(issues.map((issue) => [issue.id, issue]));

    const depth = (issue: PlannedCopy, seen = new Set<string>()): number => {
        if (issue.copyParent?.kind !== 'batch' || seen.has(issue.id)) {
            return 0;
        }

        const parent = byId.get(issue.copyParent.originalId);

        if (!parent || parent.existingCopy) {
            return 0;
        }

        seen.add(issue.id);

        return depth(parent, seen) + 1;
    };

    for (const issue of issues) {
        issue.phase = depth(issue);
    }
}

function computePlanId(input: CopyIssuesInput, issues: PlannedCopy[]): string {
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
        targetStatus: input.targetStatus === undefined ? null : normalizeName(input.targetStatus),
        copy: [...new Set(input.copy ?? ['labels'])].sort(),
        linkToOriginal: input.linkToOriginal ?? true,
        summaryPrefix: input.summaryPrefix ?? '',
        preserveLostFields: input.preserveLostFields ?? true,
        notify: input.notify ?? false,
        // Lo que hay en Jira también forma parte del plan: un original
        // editado, un hijo nuevo o una copia que aparece cambian lo aprobado.
        issues: issues
            .map((issue) =>
                [
                    issue.id,
                    issue.raw.fields.project.key,
                    issue.sourceType.id,
                    issue.sourceStatus.id,
                    issue.parent?.id ?? '',
                    String(issue.raw.fields.updated ?? ''),
                    issue.existingCopy ? `${issue.existingCopy.key}/${issue.existingCopy.status.id}` : '',
                ].join(':'),
            )
            .sort(),
    });

    return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

const PERMISSION_NAMES: Record<string, string> = {
    CREATE_ISSUES: '«Crear incidencias»',
    LINK_ISSUES: '«Enlazar incidencias»',
    TRANSITION_ISSUES: '«Transicionar incidencias»',
    ADD_COMMENTS: '«Añadir comentarios»',
    CREATE_ATTACHMENTS: '«Crear adjuntos»',
    WORK_ON_ISSUES: '«Trabajar en incidencias» (registrar tiempo)',
    ASSIGN_ISSUES: '«Asignar incidencias»',
    SET_ISSUE_SECURITY: '«Establecer seguridad de incidencias»',
    BROWSE_PROJECTS: '«Examinar proyectos»',
};

async function buildPlan(client: AxiosInstance, input: CopyIssuesInput): Promise<Plan> {
    const keys = [...new Set(input.issueKeys.map((key) => key.trim()).filter(Boolean))];

    if (keys.length === 0) {
        throw new Error('No se ha indicado ningún issue que copiar.');
    }

    const targetKey = input.targetProject.trim().toUpperCase();

    const extras = new Set<CopyExtra>(input.copy ?? ['labels']);

    const [target, statuses, catalogList, linkTypes, collected] = await Promise.all([
        fetchTargetProject(client, targetKey),
        fetchTargetStatuses(client, targetKey),
        getAllFields(),
        client.get<{ issueLinkTypes: LinkType[] }>('/rest/api/3/issueLinkType'),
        collectIssues(client, keys, input.includeChildren ?? true),
    ]);

    const catalog = new Map(catalogList.map((field) => [field.id, field]));

    const blockers: Blocker[] = collected.missing.map((key) => ({
        key,
        reason: 'No existe o no hay permiso para verlo.',
    }));

    const warnings = new Set<string>();

    const cloneType = findCloneType(linkTypes.data.issueLinkTypes);

    if (!cloneType) {
        blockers.push({
            reason: 'La instancia no tiene el tipo de enlace «Cloners» ni «Relates»: sin él no se puede enlazar cada copia con su original, ni reconocer las copias ya hechas si hay que repetir.',
        });
    } else if (normalizeName(cloneType.name) !== 'cloners') {
        warnings.add(`La instancia no tiene «Cloners»: cada copia se enlaza a su original con «${cloneType.name}».`);
    }

    const prefix = input.summaryPrefix ?? '';

    const collectedIds = new Set(collected.issues.map((issue) => issue.id));

    const issues: PlannedCopy[] = collected.issues.map((raw) => {
        const attachments = extras.has('attachments') ? issueAttachments(raw) : [];

        return {
            raw,
            key: raw.key,
            id: raw.id,
            summary: `${prefix}${raw.fields.summary}`,
            sourceType: { id: raw.fields.issuetype.id, name: raw.fields.issuetype.name },
            sourceStatus: { id: raw.fields.status.id, name: raw.fields.status.name },
            ...(raw.fields.parent && { parent: { id: raw.fields.parent.id, key: raw.fields.parent.key } }),
            subtask: raw.fields.issuetype.subtask,
            phase: 0,
            fields: {},
            lostFields: [],
            extras: {
                comments: extras.has('comments') ? totalOf(raw.fields.comment) : 0,
                attachments: attachments.length,
                attachmentBytes: attachments.reduce((sum, attachment) => sum + (attachment.size ?? 0), 0),
                worklogs: extras.has('worklogs') ? totalOf(raw.fields.worklog) : 0,
                links: 0,
            },
        };
    });

    for (const issue of issues) {
        const { type, blocker } = resolveType(issue.raw, target, input.typeMapping, 'copiar');

        if (blocker) {
            blockers.push({ key: issue.key, reason: blocker });
        } else {
            issue.targetType = type;
        }
    }

    if (cloneType) {
        await findExistingCopies(client, issues, target, cloneType, warnings);
    }

    const createMetaByType = new Map<string, CreateFieldMeta[]>();

    const graphs = new Map<string, WorkflowGraph | undefined>();

    const unreadableFlows = new Set<string>();

    const assignees = new Map<string, PlannedCopy[]>();

    for (const issue of issues) {
        if (issue.summary.length > SUMMARY_MAX) {
            blockers.push({
                key: issue.key,
                reason: `Con el prefijo, el resumen pasa de ${SUMMARY_MAX} caracteres. Usar un summaryPrefix más corto.`,
            });
        }

        // El padre de la copia: la copia del padre si se copia, o el propio
        // padre si ya está en el destino.
        if (issue.parent) {
            if (collectedIds.has(issue.parent.id)) {
                issue.copyParent = { kind: 'batch', originalId: issue.parent.id, originalKey: issue.parent.key };
            } else if (projectOf(issue.parent.key) === target.key) {
                issue.copyParent = { kind: 'existing', key: issue.parent.key };
            } else if (issue.subtask) {
                blockers.push({
                    key: issue.key,
                    reason: `Es una subtarea y su padre ${issue.parent.key} no se copia: una subtarea vive en el proyecto de su padre. Incluir el padre, o dejar fuera la subtarea.`,
                });
            } else {
                warnings.add(`${issue.key} cuelga de ${issue.parent.key}, que no se copia: su copia queda sin padre.`);
            }
        }

        const type = issue.targetType;

        if (!type) {
            continue;
        }

        const { status, blocker } = resolveCopyStatus(issue.raw, type, statuses, input, target.key);

        if (blocker) {
            blockers.push({ key: issue.key, reason: blocker });
        } else {
            issue.targetStatus = status;
        }

        const valid = statuses.get(type.id) ?? [];

        if (!graphs.has(type.id)) {
            graphs.set(type.id, await fetchWorkflowGraph(client, target.id, type.id, valid));
        }

        const graph = graphs.get(type.id);

        const named = (id: string): StatusRef =>
            valid.find((candidate) => candidate.id === id) ?? { id, name: id };

        if (!graph) {
            unreadableFlows.add(type.name);
        } else if (issue.targetStatus) {
            issue.initialStatus = named(graph.initial);

            const from = issue.existingCopy?.status.id ?? graph.initial;

            const path = findPath(graph, from, issue.targetStatus.id);

            if (path) {
                issue.path = path.map(named);
            } else {
                issue.noPath = true;
                warnings.add(
                    `En ${target.key} no hay camino de «${named(from).name}» a «${issue.targetStatus.name}» para ${type.name}: la copia de ${issue.key} se quedará en «${named(from).name}».`,
                );
            }
        }

        if (issue.existingCopy) {
            continue;
        }

        let createMeta = createMetaByType.get(type.id);

        if (!createMeta) {
            createMeta = await fetchCreateMeta(client, target.key, type.id);
            createMetaByType.set(type.id, createMeta);
        }

        const { fields, lost } = planFields(issue.raw, createMeta, catalog, extras);

        issue.fields = fields;
        issue.lostFields = lost;

        const hasDescription = createMeta.some((field) => field.id === 'description');

        if ((input.preserveLostFields ?? true) && lost.length > 0 && !hasDescription) {
            blockers.push({
                key: issue.key,
                reason: `Se perderían campos con contenido y ${type.name} no tiene descripción en ${target.key} donde conservarlos. Usar preserveLostFields: false si se aceptan perder.`,
            });
        }

        // Una copia sin el nivel de seguridad del original lo dejaría ver a más gente.
        if (!isEmpty(issue.raw.fields.security) && fields.security === undefined) {
            blockers.push({
                key: issue.key,
                reason: `El original tiene el nivel de seguridad «${toText(issue.raw.fields.security)}» y ${target.key} no lo admite: la copia sería visible para más gente que el original.`,
            });
        }

        for (const field of createMeta) {
            if (field.required && !field.hasDefaultValue && !SET_BY_COPY.has(field.id) && isEmpty(fields[field.id])) {
                const why = lost.find((entry) => entry.id === field.id);

                blockers.push({
                    key: issue.key,
                    reason: `El campo "${field.name}" (${field.id}) es obligatorio en ${target.key} para ${type.name} y la copia lo dejaría vacío${why ? ` (${why.reason})` : ''}. Rellenarlo en el original, o hacerlo opcional en el destino.`,
                });
            }
        }

        if (fields.assignee) {
            const { accountId } = fields.assignee as { accountId: string };

            assignees.set(accountId, [...(assignees.get(accountId) ?? []), issue]);
        }

        if (hasMedia(Object.values(fields))) {
            warnings.add(
                `${issue.key} tiene imágenes o archivos incrustados en el texto: en la copia siguen apuntando a los adjuntos del original.`,
            );
        }
    }

    for (const [accountId, holders] of assignees) {
        if (!(await isAssignable(client, target.key, accountId))) {
            for (const holder of holders) {
                delete holder.fields.assignee;
            }

            warnings.add(
                `La persona asignada de ${holders.map((holder) => holder.key).join(', ')} no se puede asignar en ${target.key}: esas copias quedan sin asignar.`,
            );
        }
    }

    if (unreadableFlows.size > 0) {
        warnings.add(
            `No se ha podido leer el flujo de ${[...unreadableFlows].join(', ')} en ${target.key} (hace falta administrar el proyecto): no se sabe de antemano en qué estado nace cada copia ni si se llega al pedido. Al ejecutar se busca una transición directa; si no la hay, la copia se queda en su estado inicial y la respuesta lo dice.`,
        );
    }

    const copyKeys = new Set(issues.flatMap((issue) => (issue.existingCopy ? [issue.existingCopy.key.toUpperCase()] : [])));

    for (const issue of issues) {
        issue.extras.links = issueLinks(issue.raw).filter((link) => isLinkToCopy(link, copyKeys, cloneType, target.key) === false).length;
    }

    assignPhases(issues);

    const toCreate = issues.filter((issue) => !issue.existingCopy);

    // Enlazar hace falta siempre: aunque linkToOriginal sea false, el enlace
    // con el original es lo que permite continuar sin duplicar tras un fallo.
    const needs = new Set(['CREATE_ISSUES', 'LINK_ISSUES', 'TRANSITION_ISSUES']);

    if (issues.some((issue) => issue.extras.comments > 0)) needs.add('ADD_COMMENTS');
    if (issues.some((issue) => issue.extras.attachments > 0)) needs.add('CREATE_ATTACHMENTS');
    if (issues.some((issue) => issue.extras.worklogs > 0)) needs.add('WORK_ON_ISSUES');
    if (toCreate.some((issue) => issue.fields.assignee)) needs.add('ASSIGN_ISSUES');
    if (toCreate.some((issue) => issue.fields.security)) needs.add('SET_ISSUE_SECURITY');

    const sourceProjects = [...new Set(issues.map((issue) => issue.raw.fields.project.key))];

    const [targetPermissions, ...sourcePermissions] = await Promise.all([
        hasPermissions(client, [...needs], target.key),
        ...sourceProjects.map((project) => hasPermissions(client, ['BROWSE_PROJECTS', 'LINK_ISSUES'], project)),
    ]);

    for (const permission of needs) {
        if (!targetPermissions[permission]) {
            const why =
                permission === 'LINK_ISSUES'
                    ? ' Hace falta aunque linkToOriginal sea false: el enlace con el original es lo que permite continuar sin duplicar si algo falla.'
                    : '';

            blockers.push({ reason: `Falta el permiso ${PERMISSION_NAMES[permission]} en ${target.key}.${why}` });
        }
    }

    sourceProjects.forEach((project, index) => {
        for (const [permission, granted] of Object.entries(sourcePermissions[index])) {
            if (!granted) {
                blockers.push({ reason: `Falta el permiso ${PERMISSION_NAMES[permission]} en ${project}, de donde se copia.` });
            }
        }
    });

    warnings.add(
        `Jira avisa del alta, de los comentarios y de las transiciones según el esquema de notificaciones de ${target.key}: su API no permite silenciarlos. notify solo decide si se avisa de los registros de tiempo copiados.`,
    );

    const phaseCount = Math.max(-1, ...toCreate.map((issue) => issue.phase)) + 1;

    const phases = Array.from({ length: phaseCount }, (_, phase) =>
        toCreate.filter((issue) => issue.phase === phase),
    ).filter((phase) => phase.length > 0);

    const plan: Plan = {
        target,
        ...(cloneType && { cloneType }),
        issues,
        blockers,
        warnings: [...warnings],
        phases,
    };

    if (blockers.length === 0) {
        plan.planId = computePlanId(input, issues);
    }

    return plan;
}

/**
 * El enlace de un original con una copia suya, de esta copia o de una
 * anterior. No se reproduce en la copia: la enlazaría con su hermana.
 */
function isLinkToCopy(
    link: RawLink,
    copyKeys: Set<string>,
    cloneType: LinkType | undefined,
    target: string,
): boolean {
    const other = link.outwardIssue ?? link.inwardIssue;

    if (!other || copyKeys.has(other.key.toUpperCase())) {
        return true;
    }

    return (
        cloneType !== undefined &&
        normalizeName(cloneType.name) === 'cloners' &&
        link.type.name === cloneType.name &&
        link.inwardIssue !== undefined &&
        projectOf(link.inwardIssue.key) === target
    );
}

function describeIssue(issue: PlannedCopy) {
    const parent = issue.copyParent
        ? issue.copyParent.kind === 'batch'
            ? `la copia de ${issue.copyParent.originalKey}`
            : issue.copyParent.key
        : issue.parent
          ? `ninguno (${issue.parent.key} no se copia)`
          : undefined;

    const wanted = issue.targetStatus?.name ?? '?';

    const status = issue.existingCopy
        ? `${issue.existingCopy.status.name} → ${wanted}`
        : issue.initialStatus
          ? `nace en ${issue.initialStatus.name} → ${wanted}`
          : `${issue.sourceStatus.name} → ${wanted}`;

    const copies = Object.fromEntries(
        Object.entries(issue.extras).filter(([name, count]) => count > 0 && name !== 'attachmentBytes'),
    );

    return {
        key: issue.key,
        summary: issue.summary,
        ...(issue.existingCopy && {
            alreadyCopied: issue.existingCopy.key,
            note: 'Ya tiene copia: no se crea otra; se completa lo que le falte.',
        }),
        type: `${issue.sourceType.name} → ${issue.targetType?.name ?? '?'}`,
        status,
        ...(issue.path && issue.path.length > 1 && { statusPath: issue.path.map((step) => step.name) }),
        ...(parent && { parent }),
        ...(!issue.existingCopy && Object.keys(issue.fields).length > 0 && { fields: Object.keys(issue.fields) }),
        ...(issue.lostFields.length > 0 && { lostFields: issue.lostFields.map((field) => field.name) }),
        ...(Object.keys(copies).length > 0 && { copies }),
    };
}

function summarizePlan(plan: Plan) {
    const toCreate = plan.issues.filter((issue) => !issue.existingCopy);

    const byType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};

    for (const issue of plan.issues) {
        const type = `${issue.sourceType.name} → ${issue.targetType?.name ?? 'sin equivalente'}`;
        const status = `${issue.sourceStatus.name} → ${issue.targetStatus?.name ?? 'sin equivalente'}`;

        byType[type] = (byType[type] ?? 0) + 1;
        byStatus[status] = (byStatus[status] ?? 0) + 1;
    }

    const lost = new Map<
        string,
        { field: string; id: string; reason: string; keys: string[]; sameNameInTarget?: string }
    >();

    for (const issue of toCreate) {
        for (const field of issue.lostFields) {
            const entry = lost.get(field.id) ?? {
                field: field.name,
                id: field.id,
                reason: field.reason,
                keys: [],
                ...(field.sameNameInTarget && { sameNameInTarget: field.sameNameInTarget }),
            };

            entry.keys.push(issue.key);
            lost.set(field.id, entry);
        }
    }

    const sum = (name: keyof PlannedCopy['extras']) =>
        plan.issues.reduce((total, issue) => total + issue.extras[name], 0);

    const alreadyCopied = plan.issues
        .filter((issue) => issue.existingCopy)
        .map((issue) => ({ original: issue.key, copy: issue.existingCopy!.key }));

    return {
        target: { key: plan.target.key, name: plan.target.name },
        total: plan.issues.length,
        toCreate: toCreate.length,
        ...(alreadyCopied.length > 0 && { alreadyCopied }),
        byType,
        byStatus,
        phases: plan.phases.map((phase, index) => ({
            phase: index + 1,
            issues: phase.length,
            requests: Math.ceil(phase.length / BULK_CREATE_LIMIT),
        })),
        alsoCopied: {
            comments: sum('comments'),
            attachments: sum('attachments'),
            attachmentMegabytes: Math.round((sum('attachmentBytes') / 1048576) * 10) / 10,
            worklogs: sum('worklogs'),
            links: sum('links'),
        },
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

// --- Ejecución: altas -----------------------------------------------------

function parentKeyFor(issue: PlannedCopy, copyOf: Map<string, CopyRef>): string | undefined {
    if (issue.copyParent?.kind === 'batch') {
        return copyOf.get(issue.copyParent.originalId)?.key;
    }

    return issue.copyParent?.key;
}

function createFields(
    issue: PlannedCopy,
    plan: Plan,
    copyOf: Map<string, CopyRef>,
    preserve: boolean,
): Record<string, unknown> {
    const fields: Record<string, unknown> = {
        ...issue.fields,
        project: { id: plan.target.id },
        issuetype: { id: issue.targetType!.id },
        summary: issue.summary,
    };

    const parent = parentKeyFor(issue, copyOf);

    if (parent !== undefined) {
        fields.parent = { key: parent };
    }

    if (preserve && issue.lostFields.some((field) => field.id !== 'description')) {
        const current = isAdfDocument(fields.description) ? (fields.description as AdfDocument) : undefined;

        fields.description = {
            type: 'doc',
            version: 1,
            content: [...(current?.content ?? []), ...preservedSection(issue, plan.target.key)],
        };
    }

    return fields;
}

interface BulkCreateResult {
    created: Array<{ issue: PlannedCopy } & CopyRef>;
    failed: Array<{ issue: PlannedCopy; error: string }>;
}

type BulkResponse = {
    issues?: CopyRef[];
    errors?: Array<{
        failedElementNumber: number;
        elementErrors?: { errorMessages?: string[]; errors?: Record<string, string> };
    }>;
};

/**
 * Crea un lote con la API de alta masiva. La respuesta trae las altas en el
 * orden pedido, saltándose las fallidas, que vienen aparte con su posición. El
 * emparejamiento se comprueba releyendo las copias: una copia atribuida al
 * original equivocado se enlazaría y se completaría mal.
 */
async function bulkCreate(
    client: AxiosInstance,
    batch: PlannedCopy[],
    plan: Plan,
    copyOf: Map<string, CopyRef>,
    preserve: boolean,
): Promise<BulkCreateResult> {
    let data: BulkResponse;

    try {
        const response = await client.post<BulkResponse>('/rest/api/3/issue/bulk', {
            issueUpdates: batch.map((issue) => ({ fields: createFields(issue, plan, copyOf, preserve) })),
        });

        data = response.data;
    } catch (error) {
        // Si fallan todas, Jira responde 400 con el mismo cuerpo.
        const body = (error as { response?: { data?: BulkResponse } }).response?.data;

        if (!body?.errors) {
            return { created: [], failed: batch.map((issue) => ({ issue, error: explain(error) })) };
        }

        data = body;
    }

    const failedAt = new Map(
        (data.errors ?? []).map((entry) => [
            entry.failedElementNumber,
            [
                ...(entry.elementErrors?.errorMessages ?? []),
                ...Object.entries(entry.elementErrors?.errors ?? {}).map(([field, reason]) => `${field}: ${reason}`),
            ].join(', ') || 'Jira no dio el motivo.',
        ]),
    );

    const result: BulkCreateResult = { created: [], failed: [] };

    const returned = [...(data.issues ?? [])];

    for (const [index, issue] of batch.entries()) {
        const reason = failedAt.get(index);

        if (reason !== undefined) {
            result.failed.push({ issue, error: reason });
            continue;
        }

        const created = returned.shift();

        if (!created) {
            result.failed.push({ issue, error: 'Jira no devolvió ni la copia ni un error.' });
            continue;
        }

        result.created.push({ issue, id: created.id, key: created.key });
    }

    if (result.created.length === 0) {
        return result;
    }

    const { issues: read } = await fetchIssues(client, result.created.map((entry) => entry.id));

    const byId = new Map(read.map((issue) => [issue.id, issue]));

    const expected = (issue: PlannedCopy) =>
        JSON.stringify([issue.summary, issue.targetType!.id, parentKeyFor(issue, copyOf)?.toUpperCase() ?? null]);

    const actual = (id: string) => {
        const issue = byId.get(id);

        return issue
            ? JSON.stringify([issue.fields.summary, issue.fields.issuetype.id, issue.fields.parent?.key.toUpperCase() ?? null])
            : undefined;
    };

    if (result.created.every((entry) => actual(entry.id) === expected(entry.issue))) {
        return result;
    }

    // El orden no cuadra: se empareja por resumen, tipo y padre, y solo si no
    // hay ambigüedad.
    const pool: CopyRef[] = result.created.map(({ id, key }) => ({ id, key }));

    const rematched: BulkCreateResult['created'] = [];

    for (const entry of result.created) {
        const candidates = pool.filter((candidate) => actual(candidate.id) === expected(entry.issue));

        if (candidates.length !== 1) {
            throw new Error(
                `Jira creó ${result.created.map((created) => created.key).join(', ')}, pero no se puede saber con certeza qué copia es de qué original. No se ha enlazado ni completado nada de ese lote: revisarlas a mano antes de repetir.`,
            );
        }

        pool.splice(pool.indexOf(candidates[0]), 1);
        rematched.push({ issue: entry.issue, ...candidates[0] });
    }

    return { ...result, created: rematched };
}

async function createLink(client: AxiosInstance, type: string, inward: string, outward: string): Promise<void> {
    await client.post('/rest/api/3/issueLink', {
        type: { name: type },
        inwardIssue: { key: inward },
        outwardIssue: { key: outward },
    });
}

// --- Ejecución: lo que no viaja en el alta ---------------------------------

interface CopyState {
    status: StatusRef;
    links: RawLink[];
    attachments: Array<{ filename: string; size: number }>;
}

async function readCopy(client: AxiosInstance, key: string): Promise<CopyState> {
    const response = await client.get<{
        fields: {
            status: StatusRef;
            issuelinks?: RawLink[];
            attachment?: Array<{ filename: string; size: number }>;
        };
    }>(`/rest/api/3/issue/${key}`, { params: { fields: 'status,issuelinks,attachment' } });

    const { fields } = response.data;

    return {
        status: { id: fields.status.id, name: fields.status.name },
        links: fields.issuelinks ?? [],
        attachments: fields.attachment ?? [],
    };
}

async function fetchPaged<T>(client: AxiosInstance, url: string, property: string, maxResults: number): Promise<T[]> {
    const items: T[] = [];

    for (;;) {
        const response = await client.get<Record<string, unknown>>(url, {
            params: { startAt: items.length, maxResults },
        });

        const page = (response.data[property] as T[] | undefined) ?? [];

        items.push(...page);

        const total = typeof response.data.total === 'number' ? response.data.total : items.length;

        if (page.length === 0 || items.length >= total) {
            return items;
        }
    }
}

function authorOf(value: unknown): string {
    const name = asObject(value)?.displayName;

    return typeof name === 'string' ? name : 'alguien';
}

function stamp(value: unknown): string {
    return typeof value === 'string' ? value.slice(0, 16).replace('T', ' ') : '';
}

/**
 * Párrafo con que empieza lo copiado. Jira atribuye el comentario o el
 * registro a quien copia; la autoría y la fecha originales van aquí, con el
 * identificador del original, que es lo que reconoce lo ya copiado.
 */
function attribution(lead: string, author: string, rest: string): AdfNode {
    return {
        type: 'paragraph',
        content: [
            { type: 'text', text: lead },
            { type: 'text', text: author, marks: [{ type: 'strong' }] },
            { type: 'text', text: rest },
        ],
    };
}

function startsWithText(body: unknown, text: string): boolean {
    const markdown = isAdfDocument(body) ? adfToMarkdown(body) : null;

    return markdown !== null && markdown.replace(/\*\*/g, '').startsWith(text);
}

interface StepReport {
    done: number;
    skipped: number;
    failed: string[];
}

function newReport(): StepReport {
    return { done: 0, skipped: 0, failed: [] };
}

/**
 * Lleva la copia al estado pedido: por el camino del flujo si se pudo leer, o
 * con una transición directa si no. No explora a ciegas: cada transición de
 * prueba dejaría la copia en un estado que nadie ha pedido.
 */
async function reachStatus(
    client: AxiosInstance,
    key: string,
    issue: PlannedCopy,
    current: StatusRef,
): Promise<{ status: StatusRef; error?: string }> {
    const wanted = issue.targetStatus!;

    const steps = issue.path && issue.path.length > 0 ? issue.path.map((step) => step.id) : [wanted.id];

    let status = current;

    for (const next of steps) {
        if (status.id === wanted.id) {
            break;
        }

        if (status.id === next) {
            continue;
        }

        const response = await client.get<{ transitions: Array<{ id: string; name: string; to: StatusRef }> }>(
            `/rest/api/3/issue/${key}/transitions`,
        );

        const transition = response.data.transitions.find((candidate) => candidate.to.id === next);

        if (!transition) {
            const options = response.data.transitions.map((candidate) => candidate.to.name).join(', ');

            return {
                status,
                error: `Desde «${status.name}» no hay transición ${steps.length > 1 ? 'por el camino del flujo ' : 'directa '}a «${wanted.name}». Transiciones posibles: ${options || 'ninguna'}.`,
            };
        }

        try {
            await client.post(`/rest/api/3/issue/${key}/transitions`, { transition: { id: transition.id } });
        } catch (error) {
            return { status, error: `La transición «${transition.name}» falló: ${explain(error)}` };
        }

        status = { id: transition.to.id, name: transition.to.name };
    }

    return status.id === wanted.id
        ? { status }
        : { status, error: `Quedó en «${status.name}», no en «${wanted.name}».` };
}

async function copyComments(client: AxiosInstance, issue: PlannedCopy, key: string): Promise<StepReport> {
    type Comment = { id: string; author?: unknown; created?: string; body?: unknown; visibility?: unknown };

    const [originals, existing] = await Promise.all([
        fetchPaged<Comment>(client, `/rest/api/3/issue/${issue.id}/comment`, 'comments', 100),
        fetchPaged<Comment>(client, `/rest/api/3/issue/${key}/comment`, 'comments', 100),
    ]);

    const report = newReport();

    for (const comment of originals) {
        const author = authorOf(comment.author);
        const lead = 'Comentario de ';
        const rest = ` del ${stamp(comment.created)} en ${issue.key} (${comment.id}):`;

        if (existing.some((copied) => startsWithText(copied.body, `${lead}${author}${rest}`))) {
            report.skipped += 1;
            continue;
        }

        const content = isAdfDocument(comment.body) ? (comment.body as AdfDocument).content : [];

        try {
            await client.post(`/rest/api/3/issue/${key}/comment`, {
                body: { type: 'doc', version: 1, content: [attribution(lead, author, rest), ...content] },
                // Un comentario restringido sigue restringido: si la
                // restricción no vale en el destino, no se copia.
                ...(comment.visibility !== undefined && { visibility: comment.visibility }),
            });

            report.done += 1;
        } catch (error) {
            report.failed.push(`comentario ${comment.id}: ${explain(error)}`);
        }
    }

    return report;
}

async function copyWorklogs(
    client: AxiosInstance,
    issue: PlannedCopy,
    key: string,
    notify: boolean,
): Promise<StepReport> {
    type Worklog = {
        id: string;
        author?: unknown;
        started: string;
        timeSpentSeconds: number;
        comment?: unknown;
        visibility?: unknown;
    };

    const [originals, existing] = await Promise.all([
        fetchPaged<Worklog>(client, `/rest/api/3/issue/${issue.id}/worklog`, 'worklogs', 1000),
        fetchPaged<Worklog>(client, `/rest/api/3/issue/${key}/worklog`, 'worklogs', 1000),
    ]);

    const report = newReport();

    for (const worklog of originals) {
        const author = authorOf(worklog.author);
        const lead = 'Registrado por ';
        const rest = ` en ${issue.key} (${worklog.id}).`;

        if (existing.some((copied) => startsWithText(copied.comment, `${lead}${author}${rest}`))) {
            report.skipped += 1;
            continue;
        }

        const content = isAdfDocument(worklog.comment) ? (worklog.comment as AdfDocument).content : [];

        try {
            await client.post(
                `/rest/api/3/issue/${key}/worklog`,
                {
                    started: worklog.started,
                    timeSpentSeconds: worklog.timeSpentSeconds,
                    comment: { type: 'doc', version: 1, content: [attribution(lead, author, rest), ...content] },
                    ...(worklog.visibility !== undefined && { visibility: worklog.visibility }),
                },
                // La estimación restante de la copia no se toca: es la del alta.
                { params: { adjustEstimate: 'leave', notifyUsers: notify } },
            );

            report.done += 1;
        } catch (error) {
            report.failed.push(`registro ${worklog.id}: ${explain(error)}`);
        }
    }

    return report;
}

function multipart(filename: string, mimeType: string, data: Buffer): { body: Buffer; boundary: string } {
    const boundary = `----jira-lite-${randomUUID()}`;

    const safeName = filename.replace(/["\r\n]/g, '_');

    const head = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
        'utf8',
    );

    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');

    return { body: Buffer.concat([head, data, tail]), boundary };
}

async function copyAttachments(
    client: AxiosInstance,
    issue: PlannedCopy,
    key: string,
    state: CopyState,
): Promise<StepReport> {
    const report = newReport();

    for (const attachment of issueAttachments(issue.raw)) {
        const already = state.attachments.some(
            (copied) => copied.filename === attachment.filename && copied.size === attachment.size,
        );

        if (already) {
            report.skipped += 1;
            continue;
        }

        try {
            const content = await client.get<ArrayBuffer>(`/rest/api/3/attachment/content/${attachment.id}`, {
                responseType: 'arraybuffer',
                headers: { Accept: '*/*' },
                maxContentLength: Infinity,
            });

            const { body, boundary } = multipart(
                attachment.filename,
                attachment.mimeType ?? 'application/octet-stream',
                Buffer.from(content.data),
            );

            await client.post(`/rest/api/3/issue/${key}/attachments`, body, {
                headers: {
                    'Content-Type': `multipart/form-data; boundary=${boundary}`,
                    'X-Atlassian-Token': 'no-check',
                },
                maxBodyLength: Infinity,
                maxContentLength: Infinity,
            });

            report.done += 1;
        } catch (error) {
            report.failed.push(`${attachment.filename}: ${explain(error)}`);
        }
    }

    return report;
}

/**
 * Rehace en la copia los enlaces del original. Un enlace con otro issue del
 * lote se rehace entre las dos copias, una sola vez: aparece en los dos
 * originales. Uno con un issue de fuera apunta a ese mismo issue.
 */
async function copyLinks(
    client: AxiosInstance,
    issue: PlannedCopy,
    key: string,
    state: CopyState,
    copyOf: Map<string, CopyRef>,
    copyKeys: Set<string>,
    processed: Set<string>,
    plan: Plan,
): Promise<StepReport> {
    const report = newReport();

    for (const link of issueLinks(issue.raw)) {
        if (isLinkToCopy(link, copyKeys, plan.cloneType, plan.target.key) || processed.has(link.id)) {
            continue;
        }

        processed.add(link.id);

        const other = (link.outwardIssue ?? link.inwardIssue)!;

        const otherKey = copyOf.get(other.id)?.key ?? other.key;

        // En el original, outwardIssue quiere decir «original <outward> otro».
        const [inward, outward] = link.outwardIssue ? [key, otherKey] : [otherKey, key];

        const exists = state.links.some(
            (current) =>
                current.type.name === link.type.name &&
                (link.outwardIssue
                    ? current.outwardIssue?.key.toUpperCase() === outward.toUpperCase()
                    : current.inwardIssue?.key.toUpperCase() === inward.toUpperCase()),
        );

        if (exists) {
            report.skipped += 1;
            continue;
        }

        try {
            await createLink(client, link.type.name, inward, outward);
            report.done += 1;
        } catch (error) {
            report.failed.push(`${link.type.name} con ${other.key}: ${explain(error)}`);
        }
    }

    return report;
}

function compact(report: StepReport): Partial<StepReport> | undefined {
    if (report.done === 0 && report.skipped === 0 && report.failed.length === 0) {
        return undefined;
    }

    return {
        done: report.done,
        ...(report.skipped > 0 && { skipped: report.skipped }),
        ...(report.failed.length > 0 && { failed: report.failed }),
    };
}

interface CompletedCopy extends CopyRef {
    issue: PlannedCopy;
    created: boolean;
    statusError?: string;
    steps: Partial<Record<'comments' | 'attachments' | 'worklogs' | 'links', StepReport>>;
    error?: string;
}

/** Huella del contenido de un original, sin lo que cambia al copiarlo. */
function fingerprint(issue: RawIssue): string {
    const fields = Object.fromEntries(
        Object.entries(issue.fields)
            .filter(([id]) => !VOLATILE.has(id))
            .sort(([a], [b]) => a.localeCompare(b)),
    );

    return createHash('sha256').update(JSON.stringify({ key: issue.key, fields })).digest('hex');
}

async function verify(
    client: AxiosInstance,
    completed: CompletedCopy[],
    plan: Plan,
    copyOf: Map<string, CopyRef>,
    linkToOriginal: boolean,
) {
    const { issues: read } = await fetchIssues(client, completed.map((entry) => entry.id));

    const byId = new Map(read.map((issue) => [issue.id, issue]));

    return completed.map((entry) => {
        const copy = byId.get(entry.id);

        if (!copy) {
            return { problems: ['No se pudo releer.'] };
        }

        const { issue } = entry;

        const problems: string[] = [];

        if (copy.fields.project.key !== plan.target.key) {
            problems.push(`Está en ${copy.fields.project.key}, no en ${plan.target.key}.`);
        }

        if (issue.targetType && copy.fields.issuetype.id !== issue.targetType.id) {
            problems.push(`El tipo es ${copy.fields.issuetype.name}, no ${issue.targetType.name}.`);
        }

        if (issue.targetStatus && copy.fields.status.id !== issue.targetStatus.id) {
            problems.push(`El estado es ${copy.fields.status.name}, no ${issue.targetStatus.name}.`);
        }

        const expectedParent = parentKeyFor(issue, copyOf) ?? null;

        if ((copy.fields.parent?.key ?? null) !== expectedParent) {
            problems.push(`El padre es ${copy.fields.parent?.key ?? 'ninguno'}, no ${expectedParent ?? 'ninguno'}.`);
        }

        // Los campos se comparan en las copias creadas ahora: una que ya
        // existía puede haberse editado después, y eso no es un fallo.
        const differing = entry.created
            ? Object.entries(issue.fields)
                  .filter(([id]) => !(id === 'description' && issue.lostFields.length > 0))
                  .filter(([id, sent]) => comparable(copy.fields[id]) !== comparable(sent))
                  .map(([id]) => id)
            : [];

        if (differing.length > 0) {
            problems.push(`Campos que no quedaron como en el original: ${differing.join(', ')}.`);
        }

        const linked = issueLinks(copy).some(
            (link) => link.type.name === plan.cloneType?.name && link.outwardIssue?.id === issue.id,
        );

        if (linkToOriginal && !linked) {
            problems.push(`No está enlazada a ${issue.key}.`);
        }

        const checkboxes = Object.values(copy.fields)
            .filter(isAdfDocument)
            .map(countTasks)
            .reduce((sum, count) => ({ total: sum.total + count.total, todo: sum.todo + count.todo }), {
                total: 0,
                todo: 0,
            });

        if (entry.created && checkboxes.todo !== checkboxes.total) {
            problems.push(`${checkboxes.total - checkboxes.todo} de ${checkboxes.total} casillas están marcadas.`);
        }

        return {
            project: copy.fields.project.key,
            type: copy.fields.issuetype.name,
            status: copy.fields.status.name,
            parent: copy.fields.parent?.key ?? null,
            ...(entry.created && { fieldsCopied: Object.keys(issue.fields) }),
            ...(checkboxes.total > 0 && { checkboxes }),
            ...(linkToOriginal && { linkedToOriginal: linked }),
            ...(problems.length > 0 ? { problems } : { verified: true }),
        };
    });
}

async function execute(client: AxiosInstance, input: CopyIssuesInput, progress: MoveProgress) {
    if (!input.planId) {
        return {
            mode: 'execute',
            outcome: 'refused',
            message:
                'No se ha copiado nada: execute necesita el planId de un plan previo con la misma entrada. Pedir mode: "plan", revisarlo y repetir con su planId.',
        };
    }

    const issuedAt = issuedPlans.get(input.planId);

    if (issuedAt === undefined || Date.now() - issuedAt > PLAN_TTL_MS) {
        return {
            mode: 'execute',
            outcome: 'refused',
            message: `No se ha copiado nada: el plan ${input.planId} no lo emitió este servidor o caducó (dura ${PLAN_TTL_MS / 60000} minutos y no sobrevive a un reinicio de la sesión). Repetir el plan.`,
        };
    }

    await progress('Repitiendo las comprobaciones del plan', 0);

    const plan = await buildPlan(client, input);

    if (plan.blockers.length > 0) {
        return {
            mode: 'execute',
            outcome: 'blocked',
            message: 'No se ha copiado nada: al repetir las comprobaciones hay bloqueos.',
            ...summarizePlan(plan),
        };
    }

    if (plan.planId !== input.planId) {
        return {
            mode: 'execute',
            outcome: 'refused',
            message:
                'No se ha copiado nada: la entrada o los issues han cambiado desde el plan (otra entrada, un original editado, un hijo nuevo, una copia que ya existe). Repetir el plan y revisarlo.',
        };
    }

    issuedPlans.delete(input.planId);

    const extras = new Set<CopyExtra>(input.copy ?? ['labels']);
    const notify = input.notify ?? false;
    const preserve = input.preserveLostFields ?? true;
    const linkToOriginal = input.linkToOriginal ?? true;
    const cloneType = plan.cloneType!;

    const deadline = Date.now() + Math.min(input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS, 1800) * 1000;

    const timeline: string[] = [];

    const total = plan.issues.length;

    let done = 0;

    const report = async (message: string) => {
        timeline.push(message);
        await progress(message, done, total);
    };

    const copyOf = new Map<string, CopyRef>();

    const completed: CompletedCopy[] = [];

    for (const issue of plan.issues) {
        if (issue.existingCopy) {
            copyOf.set(issue.id, { id: issue.existingCopy.id, key: issue.existingCopy.key });
            completed.push({ issue, id: issue.existingCopy.id, key: issue.existingCopy.key, created: false, steps: {} });
        }
    }

    const failedCreations = new Map<string, string>();

    let stopped: string | undefined;

    // 1. Altas por profundidad, enlazando cada copia a su original.
    creation: for (const [index, phase] of plan.phases.entries()) {
        for (const batch of chunk(phase, BULK_CREATE_LIMIT)) {
            if (Date.now() > deadline) {
                stopped = `Se agotó el tiempo antes de terminar la fase ${index + 1}.`;
                break creation;
            }

            await report(`Fase ${index + 1}: creando ${batch.length} copias`);

            let result: BulkCreateResult;

            try {
                result = await bulkCreate(client, batch, plan, copyOf, preserve);
            } catch (error) {
                stopped = error instanceof Error ? error.message : String(error);
                break creation;
            }

            for (const created of result.created) {
                copyOf.set(created.issue.id, { id: created.id, key: created.key });

                const entry: CompletedCopy = { issue: created.issue, id: created.id, key: created.key, created: true, steps: {} };

                completed.push(entry);

                try {
                    await createLink(client, cloneType.name, created.key, created.issue.key);
                } catch (error) {
                    entry.error = `No se pudo enlazar con ${created.issue.key} (${explain(error)}). Un plan nuevo no la reconocerá como copia: enlazarla a mano con «${cloneType.outward}», o borrarla, antes de repetir.`;
                    stopped = `${created.key} se creó pero no se pudo enlazar con su original.`;
                }

                done += 1;
            }

            for (const failed of result.failed) {
                failedCreations.set(failed.issue.id, failed.error);
            }

            if (result.failed.length > 0) {
                stopped ??= `La fase ${index + 1} no se creó entera: no se sigue, para no crear hijos sin la copia de su padre.`;
            }

            if (stopped) {
                break creation;
            }
        }
    }

    // 2. Lo que no viaja en el alta, copia por copia. Solo si están todas: el
    // siguiente plan completará también las que se queden a medias.
    if (!stopped) {
        const copyKeys = new Set([...copyOf.values()].map((copy) => copy.key.toUpperCase()));

        const processedLinks = new Set<string>();

        done = 0;

        for (const entry of completed) {
            if (Date.now() > deadline) {
                stopped = 'Se agotó el tiempo completando las copias.';
                break;
            }

            await report(`Completando ${entry.key} (copia de ${entry.issue.key})`);

            try {
                const state = await readCopy(client, entry.key);

                if (entry.issue.targetStatus && !entry.issue.noPath) {
                    const reached = await reachStatus(client, entry.key, entry.issue, state.status);

                    if (reached.error) {
                        entry.statusError = reached.error;
                    }
                }

                if (extras.has('comments')) {
                    entry.steps.comments = await copyComments(client, entry.issue, entry.key);
                }

                if (extras.has('attachments')) {
                    entry.steps.attachments = await copyAttachments(client, entry.issue, entry.key, state);
                }

                if (extras.has('worklogs')) {
                    entry.steps.worklogs = await copyWorklogs(client, entry.issue, entry.key, notify);
                }

                entry.steps.links = await copyLinks(
                    client,
                    entry.issue,
                    entry.key,
                    state,
                    copyOf,
                    copyKeys,
                    processedLinks,
                    plan,
                );
            } catch (error) {
                entry.error = explain(error);
            }

            done += 1;
        }
    }

    const notCreated = plan.issues
        .filter((issue) => !copyOf.has(issue.id))
        .map((issue) => ({
            key: issue.key,
            reason: failedCreations.get(issue.id) ?? 'No llegó a crearse: el proceso se detuvo antes.',
        }));

    const stepsFailed = (entry: CompletedCopy) =>
        Object.values(entry.steps).some((step) => step !== undefined && step.failed.length > 0);

    const complete =
        !stopped &&
        notCreated.length === 0 &&
        completed.every((entry) => !entry.error && !entry.statusError && !stepsFailed(entry));

    // Sin linkToOriginal, el enlace solo servía para poder continuar tras un
    // fallo: se quita cuando ya no hace falta.
    let unlinked = 0;

    if (!linkToOriginal && complete) {
        await report('Quitando los enlaces temporales con los originales');

        for (const entry of completed) {
            try {
                const state = await readCopy(client, entry.key);

                for (const link of state.links) {
                    if (link.type.name === cloneType.name && link.outwardIssue?.id === entry.issue.id) {
                        await client.delete(`/rest/api/3/issueLink/${link.id}`);
                        unlinked += 1;
                    }
                }
            } catch (error) {
                entry.error = `No se pudo quitar el enlace temporal con ${entry.issue.key}: ${explain(error)}`;
            }
        }
    }

    await report('Verificando las copias y los originales');

    const checks = completed.length > 0 ? await verify(client, completed, plan, copyOf, linkToOriginal) : [];

    const { issues: originalsNow } = await fetchIssues(client, plan.issues.map((issue) => issue.id));

    const nowById = new Map(originalsNow.map((issue) => [issue.id, issue]));

    const changedOriginals = plan.issues
        .filter((issue) => {
            const now = nowById.get(issue.id);

            return !now || fingerprint(now) !== fingerprint(issue.raw);
        })
        .map((issue) => issue.key);

    const copies = completed.map((entry, index) => {
        const steps = Object.fromEntries(
            Object.entries(entry.steps)
                .map(([name, step]) => [name, step && compact(step)])
                .filter(([, step]) => step !== undefined),
        );

        return {
            original: entry.issue.key,
            copy: entry.key,
            ...(!entry.created && { note: 'Ya existía: se ha completado lo que le faltaba.' }),
            ...(entry.statusError && { statusError: entry.statusError }),
            ...(Object.keys(steps).length > 0 && { alsoCopied: steps }),
            ...(entry.error && { error: entry.error }),
            verification: checks[index],
        };
    });

    const withProblems = completed.filter(
        (entry, index) =>
            entry.error !== undefined ||
            entry.statusError !== undefined ||
            stepsFailed(entry) ||
            (checks[index] !== undefined && 'problems' in checks[index]),
    ).length;

    const createdNow = completed.filter((entry) => entry.created).length;

    const outcome =
        complete && withProblems === 0 ? 'copied' : completed.length === 0 ? 'nothing-copied' : 'partial';

    const message =
        outcome === 'copied'
            ? `Copiados y verificados ${completed.length} issues en ${plan.target.key} (${createdNow} creados en esta ejecución).`
            : outcome === 'nothing-copied'
              ? `No se ha copiado ningún issue a ${plan.target.key}.`
              : `Copia incompleta: ${completed.length} de ${total} originales tienen copia en ${plan.target.key}${withProblems > 0 ? `, ${withProblems} con diferencias o pasos fallidos` : ''}${notCreated.length > 0 ? `, y ${notCreated.length} no la tienen` : ''}. Repetir el plan con la misma entrada continúa desde aquí sin duplicar.`;

    return {
        mode: 'execute',
        outcome,
        message,
        ...(stopped && { stopped }),
        copies,
        ...(notCreated.length > 0 && { notCreated }),
        originalsUnchanged: changedOriginals.length === 0,
        ...(changedOriginals.length > 0 && {
            changedOriginals,
            changedOriginalsNote:
                'Su contenido difiere del leído en el plan. La copia no los edita: puede haberlos cambiado alguien mientras tanto.',
        }),
        ...(unlinked > 0 && { temporaryLinksRemoved: unlinked }),
        progress: timeline,
    };
}

export async function copyIssues(input: CopyIssuesInput, progress: MoveProgress = async () => {}) {
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
                      nextStep: `Sin bloqueos. Para copiar, repetir la llamada con la misma entrada, mode: "execute" y planId: "${plan.planId}" (válido ${PLAN_TTL_MS / 60000} minutos, en esta sesión).`,
                  }
                : {
                      nextStep: 'Hay bloqueos: resolverlos y repetir el plan. execute no copiará nada mientras los haya.',
                  }),
            ...summarizePlan(plan),
        };
    } catch (error) {
        handleJiraError(error);
    }
}
