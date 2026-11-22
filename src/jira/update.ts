import axios from 'axios';

import { createJiraClient } from './client.js';
import { handleJiraError } from './error.js';
import { buildCustomFields, findField } from './fields.js';
import { markdownToAdf } from './markdown.js';
import { resolveMentions } from './mentions.js';
import { getEditableFields } from './meta.js';
import { resolveAccountId } from './users.js';
import { addWatchers } from './watchers.js';
import { normalizeName } from './names.js';

import type {
    JiraFieldSpec,
    JiraUpdateIssueInput,
    JiraUpdatedIssue,
} from '../types/jira.js';

/**
 * Rechaza los campos que el issue no admite editar. Jira ignora en silencio lo
 * que no está en la pantalla de edición, de modo que sin esta comprobación una
 * actualización podría darse por buena sin haber cambiado nada.
 */
function assertEditable(
    fieldId: string,
    label: string,
    spec: JiraFieldSpec[],
    issueKey: string,
): void {
    if (findField(spec, fieldId)) {
        return;
    }

    const available = spec.map((field) => `"${field.name}"`).join(', ');

    throw new Error(
        `El campo ${label} no se puede editar en ${issueKey}. Campos editables: ${available || 'ninguno'}`,
    );
}

interface ApiIssueType {
    id: string;
    name: string;
    subtask: boolean;
    hierarchyLevel?: number;
}

/** Lo que hace falta de un issue para saber dónde puede colgar. */
interface IssueShape {
    key: string;
    project: string;
    type: ApiIssueType;
    parent: { key: string; summary: string } | null;
}

async function readShape(issueKey: string): Promise<IssueShape> {
    const response = await createJiraClient().get<{
        key: string;
        fields: {
            project: { key: string };
            issuetype: ApiIssueType;
            parent?: { key: string; fields: { summary: string } };
        };
    }>(`/rest/api/3/issue/${issueKey}`, {
        params: { fields: 'project,issuetype,parent' },
    });

    const { fields } = response.data;

    return {
        key: response.data.key,
        project: fields.project.key,
        type: fields.issuetype,
        parent: fields.parent
            ? { key: fields.parent.key, summary: fields.parent.fields.summary }
            : null,
    };
}

/**
 * Nivel en la jerarquía: -1 subtarea, 0 issue estándar, 1 épica, y por encima
 * los que el sitio defina. Jira lo informa en `hierarchyLevel`; si faltara, se
 * deduce de `subtask`.
 */
function levelOf(type: ApiIssueType): number {
    return type.hierarchyLevel ?? (type.subtask ? -1 : 0);
}

function describeLevel(level: number): string {
    if (level === -1) return 'una subtarea';
    if (level === 0) return 'un issue estándar';
    if (level === 1) return 'una épica';
    return `un issue de nivel ${level} de la jerarquía`;
}

/**
 * Comprueba que el nuevo padre está justo un nivel por encima. Jira rechaza lo
 * demás con mensajes que no dicen qué jerarquía esperaba, y el caso típico —
 * colgar una tarea de otra tarea— solo se resuelve convirtiéndola en subtarea,
 * que no se puede hacer editando.
 */
async function assertParent(
    child: IssueShape,
    parentKey: string,
): Promise<IssueShape> {
    if (parentKey.trim().toUpperCase() === child.key.toUpperCase()) {
        throw new Error(`Un issue no puede ser su propio padre (${child.key}).`);
    }

    let parent: IssueShape;

    try {
        parent = await readShape(parentKey.trim());
    } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 404) {
            throw new Error(
                `El padre indicado, ${parentKey}, no existe o no es visible con estas credenciales.`,
            );
        }

        throw error;
    }

    const childLevel = levelOf(child.type);
    const parentLevel = levelOf(parent.type);

    if (parentLevel !== childLevel + 1) {
        const hint =
            childLevel === 0 && parentLevel === 0
                ? ' Para colgarlo de otro issue estándar tendría que ser una subtarea, y convertirlo no se hace editando: en la web de Jira, «Mover».'
                : childLevel === -1 && parentLevel === 1
                  ? ' Una subtarea cuelga de un issue estándar, no de una épica: hay que colgarla de una tarea o historia de esa épica.'
                  : '';

        throw new Error(
            `${child.key} es ${describeLevel(childLevel)} (${child.type.name}), así que su padre tiene que ser ${describeLevel(childLevel + 1)}; ${parent.key} es ${describeLevel(parentLevel)} (${parent.type.name}).${hint}`,
        );
    }

    if (childLevel === -1 && parent.project !== child.project) {
        throw new Error(
            `${child.key} es una subtarea y solo puede colgar de un issue de su proyecto (${child.project}); ${parent.key} es de ${parent.project}.`,
        );
    }

    return parent;
}

/**
 * Resuelve el tipo de destino contra los que ofrece la pantalla de edición y
 * rechaza los cambios de nivel. Pasar de subtarea a tarea, o de tarea a épica,
 * cambia de quién cuelga el issue y quién cuelga de él: Jira solo lo hace con
 * el asistente «Mover» de la web.
 */
async function resolveIssueType(
    wanted: string,
    current: IssueShape,
    spec: JiraFieldSpec[],
): Promise<ApiIssueType> {
    const field = spec.find((candidate) => candidate.id === 'issuetype');

    const allowed = field?.allowedValues ?? [];

    if (allowed.length === 0) {
        throw new Error(
            `Jira no ofrece cambiar el tipo de ${current.key} por API. Hay que hacerlo en la web, con «Mover».`,
        );
    }

    const needle = normalizeName(wanted);

    const match = allowed.find(
        (value) =>
            value.id === wanted.trim() || normalizeName(value.name) === needle,
    );

    if (!match || match.id === null) {
        throw new Error(
            `Tipo de issue "${wanted}" no disponible para ${current.key}. Tipos que ofrece Jira: ${allowed.map((value) => `"${value.name}"`).join(', ')}`,
        );
    }

    const response = await createJiraClient().get<ApiIssueType>(
        `/rest/api/3/issuetype/${match.id}`,
    );

    const target = response.data;

    if (levelOf(target) !== levelOf(current.type)) {
        throw new Error(
            `${current.key} es ${describeLevel(levelOf(current.type))} (${current.type.name}) y ${target.name} es ${describeLevel(levelOf(target))}. Por API solo se cambia entre tipos del mismo nivel; un cambio de nivel se hace en la web de Jira, con «Mover».`,
        );
    }

    return target;
}

function buildFields(
    input: JiraUpdateIssueInput,
    spec: JiraFieldSpec[],
    assigneeId?: string,
    issueTypeId?: string,
): Record<string, unknown> {
    const fields: Record<string, unknown> = {};

    // El padre y el tipo se validan antes, contra la jerarquía, en lugar de
    // contra la pantalla de edición: Jira lista `issuetype` sin operaciones
    // aunque acepte el cambio entre tipos que comparten flujo y campos.
    if (input.parent !== undefined) {
        fields.parent = { key: input.parent.trim() };
    }

    if (issueTypeId !== undefined) {
        fields.issuetype = { id: issueTypeId };
    }

    if (input.summary !== undefined) {
        assertEditable('summary', '"Resumen"', spec, input.issueKey);
        fields.summary = input.summary;
    }

    if (input.description !== undefined) {
        assertEditable('description', '"Descripción"', spec, input.issueKey);
        fields.description = markdownToAdf(input.description);
    }

    if (assigneeId !== undefined) {
        assertEditable('assignee', '"Persona asignada"', spec, input.issueKey);
        fields.assignee = { id: assigneeId };
    }

    // Como al crear: Jira acepta la estimación aunque `timetracking` no figure
    // en la pantalla de edición, así que no se comprueba contra el esquema.
    // Las dos van en el mismo objeto: la que no se indica queda como estaba.
    if (
        input.originalEstimate !== undefined ||
        input.remainingEstimate !== undefined
    ) {
        fields.timetracking = {
            ...(input.originalEstimate !== undefined && {
                originalEstimate: input.originalEstimate,
            }),
            ...(input.remainingEstimate !== undefined && {
                remainingEstimate: input.remainingEstimate,
            }),
        };
    }

    if (input.priority !== undefined) {
        assertEditable('priority', '"Prioridad"', spec, input.issueKey);
        fields.priority = { name: input.priority };
    }

    if (input.labels !== undefined) {
        assertEditable('labels', '"Etiquetas"', spec, input.issueKey);
        fields.labels = input.labels;
    }

    Object.assign(
        fields,
        buildCustomFields(
            input.customFields ?? {},
            spec,
            `al editar ${input.issueKey}`,
        ),
    );

    if (Object.keys(fields).length === 0 && input.watchers === undefined) {
        throw new Error(
            `No se indicó ningún campo que actualizar en ${input.issueKey}`,
        );
    }

    return fields;
}

/**
 * Relee la estimación tras escribirla. Jira no recalcula el restante al cambiar
 * la estimación original, y la respuesta de la edición no trae nada: sin esto,
 * un restante viejo quedaba en el issue sin que nada lo señalara.
 */
async function readTimetracking(
    input: JiraUpdateIssueInput,
): Promise<Pick<JiraUpdatedIssue, 'timetracking' | 'warning'>> {
    const response = await createJiraClient().get<{
        fields: {
            timetracking?: {
                originalEstimate?: string;
                originalEstimateSeconds?: number;
                remainingEstimate?: string;
                remainingEstimateSeconds?: number;
            };
        };
    }>(`/rest/api/3/issue/${input.issueKey}`, {
        params: { fields: 'timetracking' },
    });

    const read = response.data.fields.timetracking ?? {};

    const timetracking = {
        originalEstimate: read.originalEstimate ?? null,
        remainingEstimate: read.remainingEstimate ?? null,
    };

    // Solo se avisa si se cambió la estimación sin decir nada del restante y
    // los dos no coinciden. Con horas registradas puede ser lo correcto, así
    // que no se corrige: se dice, y lo decide quien llama.
    const stale =
        input.originalEstimate !== undefined &&
        input.remainingEstimate === undefined &&
        read.remainingEstimateSeconds !== undefined &&
        read.remainingEstimateSeconds !== read.originalEstimateSeconds;

    return {
        timetracking,
        ...(stale && {
            warning: `Jira no recalcula el tiempo restante al cambiar la estimación: sigue en ${timetracking.remainingEstimate}. Si debe cambiar, indica remainingEstimate.`,
        }),
    };
}

/**
 * Añade al rechazo de Jira qué hacer cuando lo que falla es el tipo o el
 * padre. Sus mensajes para estos dos campos no dicen que el camino que queda es
 * el asistente de la web.
 */
function explainRejection(error: unknown): never {
    if (axios.isAxiosError(error)) {
        const errors = (error.response?.data as { errors?: Record<string, string> })
            ?.errors ?? {};

        let message: string;

        try {
            handleJiraError(error);
        } catch (normalized) {
            message = normalized instanceof Error ? normalized.message : String(normalized);
        }

        if ('issuetype' in errors) {
            throw new Error(
                `${message!}. Jira solo cambia el tipo por API entre tipos que comparten flujo de trabajo y esquema de campos; si no, hay que hacerlo en la web, con «Mover».`,
            );
        }

        if ('parent' in errors) {
            throw new Error(
                `${message!}. Jira no ha admitido ese padre; si el cambio exige pasar de una jerarquía a otra, se hace en la web, con «Mover».`,
            );
        }
    }

    handleJiraError(error);
}

/**
 * Relee el tipo y el padre tras escribirlos. Jira puede aceptar la edición sin
 * aplicar el cambio de tipo; sin releer, la respuesta afirmaría algo que no
 * pasó.
 */
async function confirmHierarchy(
    input: JiraUpdateIssueInput,
    requestedType: ApiIssueType | undefined,
): Promise<Pick<JiraUpdatedIssue, 'issueType' | 'parent'> & { warnings: string[] }> {
    const shape = await readShape(input.issueKey);

    const warnings: string[] = [];

    if (requestedType !== undefined && shape.type.id !== requestedType.id) {
        warnings.push(
            `Jira aceptó la edición pero el tipo sigue siendo ${shape.type.name}, no ${requestedType.name}. Hay que cambiarlo en la web, con «Mover».`,
        );
    }

    if (
        input.parent !== undefined &&
        shape.parent?.key.toUpperCase() !== input.parent.trim().toUpperCase()
    ) {
        warnings.push(
            `Jira aceptó la edición pero el padre es ${shape.parent?.key ?? 'ninguno'}, no ${input.parent}.`,
        );
    }

    return {
        ...(requestedType !== undefined && { issueType: shape.type.name }),
        ...(input.parent !== undefined && { parent: shape.parent }),
        warnings,
    };
}

export async function updateIssue(
    input: JiraUpdateIssueInput,
): Promise<JiraUpdatedIssue> {
    try {
        const spec = await getEditableFields(input.issueKey);

        const touchesHierarchy =
            input.parent !== undefined || input.issueType !== undefined;

        const shape = touchesHierarchy
            ? await readShape(input.issueKey)
            : undefined;

        if (input.parent !== undefined) {
            assertEditable('parent', '"Padre"', spec, input.issueKey);
            await assertParent(shape!, input.parent);
        }

        const issueType =
            input.issueType !== undefined
                ? await resolveIssueType(input.issueType, shape!, spec)
                : undefined;

        const assigneeId =
            input.assignee !== undefined
                ? await resolveAccountId(input.assignee)
                : undefined;

        const fields = await resolveMentions(
            buildFields(input, spec, assigneeId, issueType?.id),
        );

        const client = createJiraClient();

        if (Object.keys(fields).length > 0) {
            try {
                await client.put(`/rest/api/3/issue/${input.issueKey}`, {
                    fields,
                });
            } catch (error) {
                explainRejection(error);
            }
        }

        const { warning: estimateWarning, ...estimate } =
            'timetracking' in fields ? await readTimetracking(input) : {};

        const { warnings: hierarchyWarnings, ...hierarchy } = touchesHierarchy
            ? await confirmHierarchy(input, issueType)
            : { warnings: [] as string[] };

        const warnings = [
            ...(estimateWarning !== undefined ? [estimateWarning] : []),
            ...hierarchyWarnings,
        ];

        const watchers =
            input.watchers !== undefined && input.watchers.length > 0
                ? await addWatchers(input.issueKey, input.watchers)
                : undefined;

        return {
            key: input.issueKey,
            updated: Object.keys(fields),
            ...estimate,
            ...hierarchy,
            ...(warnings.length > 0 && { warning: warnings.join(' ') }),
            ...(watchers !== undefined && { watchers }),
        };
    } catch (error) {
        handleJiraError(error);
    }
}
