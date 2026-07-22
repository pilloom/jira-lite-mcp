import { getRequiredByPolicy } from '../config/env.js';

import { textToAdf } from './adf.js';
import { createJiraClient } from './client.js';
import { handleJiraError } from './error.js';
import { buildCustomFields, findField } from './fields.js';
import { getIssueTypeFields } from './meta.js';
import { resolveAccountId } from './users.js';
import { addWatchers } from './watchers.js';

import type {
    JiraCreateIssueInput,
    JiraCreatedIssue,
    JiraFieldSpec,
} from '../types/jira.js';

interface JiraApiCreatedIssueResponse {
    key: string;
}

/**
 * Campos que el servidor resuelve por su cuenta o que Jira completa con el
 * usuario autenticado. No se exigen al llamante aunque el esquema los marque
 * como obligatorios.
 */
const FIELDS_HANDLED_BY_SERVER = new Set(['project', 'issuetype', 'reporter']);

/**
 * Comprueba el payload contra el esquema real del proyecto y tipo de issue
 * antes de enviarlo, para que el error explique qué corregir en lugar de
 * llegar como un rechazo genérico de la API.
 *
 * Medido el 2026-07-19: ni esta comprobación ni un rechazo de Jira consumen
 * claves de issue —el contador no avanzó en tres intentos fallidos seguidos—.
 * Aun así conviene validar aquí: el mensaje es más útil y no gasta una llamada.
 */
function buildFields(
    input: JiraCreateIssueInput,
    spec: JiraFieldSpec[],
    assigneeId?: string,
): Record<string, unknown> {
    const fields: Record<string, unknown> = {
        project: { key: input.project },
        issuetype: { name: input.issueType },
        summary: input.summary,
    };

    if (input.description !== undefined) {
        fields.description = textToAdf(input.description);
    }

    if (input.parent !== undefined) {
        fields.parent = { key: input.parent };
    }

    if (assigneeId !== undefined) {
        fields.assignee = { id: assigneeId };
    }

    if (input.priority !== undefined) {
        fields.priority = { name: input.priority };
    }

    if (input.labels !== undefined) {
        fields.labels = input.labels;
    }

    // La estimación se envía sin comprobarla contra el esquema: Jira la acepta
    // aunque `timetracking` no figure en la pantalla de creación, así que
    // validarla habría impedido estimar en proyectos donde sí funciona.
    if (input.originalEstimate !== undefined) {
        fields.timetracking = { originalEstimate: input.originalEstimate };
    }

    Object.assign(
        fields,
        buildCustomFields(
            input.customFields ?? {},
            spec,
            `al crear un issue de tipo ${input.issueType} en el proyecto ${input.project}`,
        ),
    );

    const missing = spec
        .filter(
            (field) =>
                field.required &&
                !FIELDS_HANDLED_BY_SERVER.has(field.id) &&
                fields[field.id] === undefined,
        )
        .map((field) => `"${field.name}" (${field.id})`);

    if (missing.length > 0) {
        throw new Error(
            `Faltan campos obligatorios para crear un issue de tipo ${input.issueType} en el proyecto ${input.project}: ${missing.join(', ')}`,
        );
    }

    return fields;
}

function isEmpty(value: unknown): boolean {
    // Un campo presente pero sin contenido es tan olvido como uno ausente, y
    // además engaña: aparenta haberse rellenado.
    return (
        value === undefined ||
        value === null ||
        value === '' ||
        (Array.isArray(value) && value.length === 0)
    );
}

/**
 * Lee del issue padre los campos indicados. Una subtarea hereda parte del
 * contexto de su principal, de modo que un campo exigido puede estar cubierto
 * sin figurar en su propio payload.
 */
async function readFromParent(
    parentKey: string,
    fieldIds: string[],
): Promise<Record<string, unknown>> {
    const client = createJiraClient();

    const response = await client.get<{ fields: Record<string, unknown> }>(
        `/rest/api/3/issue/${parentKey}`,
        { params: { fields: fieldIds.join(',') } },
    );

    return response.data.fields;
}

/**
 * Exige los campos que el equipo da por obligatorios aunque el esquema no lo
 * haga. No se rellenan por su cuenta: se rechaza la creación para que el valor
 * lo decida siempre quien la pide.
 *
 * En una subtarea el requisito se comprueba contra el principal. Jira hereda
 * ahí parte del contexto —y llega a rechazar que se envíe explícitamente, como
 * ocurre con el equipo asignado—, así que exigirlo en el payload haría
 * imposible crear subtareas en un proyecto con esta política.
 */
async function assertPolicyFields(
    input: JiraCreateIssueInput,
    fields: Record<string, unknown>,
    spec: JiraFieldSpec[],
    isSubtask: boolean,
): Promise<void> {
    const required = getRequiredByPolicy(input.project);

    if (required.length === 0) {
        return;
    }

    const unknownFields: string[] = [];
    const pending: JiraFieldSpec[] = [];

    for (const name of required) {
        const field = findField(spec, name);

        if (!field) {
            // Configurado pero inexistente en este tipo de issue: se avisa en
            // lugar de callar, porque delata una configuración desfasada.
            unknownFields.push(`"${name}"`);

            continue;
        }

        if (isEmpty(fields[field.id])) {
            pending.push(field);
        }
    }

    if (unknownFields.length > 0) {
        throw new Error(
            `La política de ${input.project} exige campos que no existen al crear un issue de tipo ${input.issueType}: ${unknownFields.join(', ')}. Revisar JIRA_REQUIRED_FIELDS_${input.project.toUpperCase()}.`,
        );
    }

    if (pending.length === 0) {
        return;
    }

    const inherited =
        isSubtask && input.parent !== undefined
            ? await readFromParent(
                  input.parent,
                  pending.map((field) => field.id),
              )
            : {};

    const missing = pending
        .filter((field) => isEmpty(inherited[field.id]))
        .map((field) => `"${field.name}" (${field.id})`);

    if (missing.length === 0) {
        return;
    }

    const where =
        isSubtask && input.parent !== undefined
            ? ` Al ser una subtarea, el valor se hereda de ${input.parent}: hay que establecerlo ahí, no en la subtarea.`
            : '';

    throw new Error(
        `El proyecto ${input.project} exige por convención del equipo campos que Jira no marca como obligatorios y cuya ausencia no señala: ${missing.join(', ')}.${where} Configurado en JIRA_REQUIRED_FIELDS_${input.project.toUpperCase()}.`,
    );
}

/**
 * Relee la estimación tal como ha quedado registrada, con su equivalencia en
 * segundos: el sufijo de días se interpreta según la jornada del sitio, así que
 * lo pedido y lo guardado no tienen por qué coincidir.
 */
async function readTimetracking(
    issueKey: string,
): Promise<{ originalEstimate: string | null; originalEstimateSeconds: number | null }> {
    const client = createJiraClient();

    const response = await client.get<{
        fields: {
            timetracking: {
                originalEstimate?: string;
                originalEstimateSeconds?: number;
            };
        };
    }>(`/rest/api/3/issue/${issueKey}`, { params: { fields: 'timetracking' } });

    const timetracking = response.data.fields.timetracking;

    return {
        originalEstimate: timetracking.originalEstimate ?? null,
        originalEstimateSeconds: timetracking.originalEstimateSeconds ?? null,
    };
}

export async function createIssue(
    input: JiraCreateIssueInput,
): Promise<JiraCreatedIssue> {
    try {
        // El esquema se consulta antes de escribir: valida el payload y aporta
        // el tipo real de cada campo, que determina cómo serializarlo.
        const meta = await getIssueTypeFields(input.project, input.issueType);

        const assigneeId =
            input.assignee !== undefined
                ? await resolveAccountId(input.assignee)
                : undefined;

        const fields = buildFields(
            { ...input, issueType: meta.issueType },
            meta.fields,
            assigneeId,
        );

        await assertPolicyFields(
            { ...input, issueType: meta.issueType },
            fields,
            meta.fields,
            meta.isSubtask,
        );

        const applied = Object.keys(fields);

        if (input.dryRun === true) {
            return {
                dryRun: true,
                key: null,
                url: null,
                applied,
                fields,
            };
        }

        const client = createJiraClient();

        const response = await client.post<JiraApiCreatedIssueResponse>(
            '/rest/api/3/issue',
            { fields },
        );

        const key = response.data.key;

        // Los observadores no forman parte del issue: cada uno se añade con su
        // propia petición una vez existe.
        const watchers =
            input.watchers !== undefined && input.watchers.length > 0
                ? await addWatchers(key, input.watchers)
                : undefined;

        // La creación no devuelve los campos resultantes, así que la estimación
        // se relee: es la única forma de comprobar que Jira la interpretó como
        // se pedía, y su unidad depende de la jornada configurada en el sitio.
        const timetracking =
            input.originalEstimate !== undefined
                ? await readTimetracking(key)
                : undefined;

        return {
            key,
            url: `${client.defaults.baseURL}/browse/${key}`,
            applied,
            ...(timetracking !== undefined && { timetracking }),
            ...(watchers !== undefined && { watchers }),
        };
    } catch (error) {
        handleJiraError(error);
    }
}
