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
 * antes de enviarlo. Jira reserva la clave del issue al procesar la petición,
 * así que un payload inválido consume una clave de forma irreversible: los
 * errores previsibles deben detectarse aquí, no en la API.
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

    assertPolicyFields(input.project, fields, spec);

    return fields;
}

/**
 * Exige los campos que el equipo da por obligatorios aunque el esquema no lo
 * haga. No se rellenan por su cuenta: se rechaza la creación para que el valor
 * lo decida siempre quien la pide.
 */
function assertPolicyFields(
    projectKey: string,
    fields: Record<string, unknown>,
    spec: JiraFieldSpec[],
): void {
    const required = getRequiredByPolicy(projectKey);

    if (required.length === 0) {
        return;
    }

    const missing: string[] = [];

    for (const name of required) {
        const field = findField(spec, name);

        if (!field) {
            // Configurado pero inexistente en este tipo de issue: se avisa en
            // lugar de callar, porque delata una configuración desfasada.
            missing.push(
                `"${name}" (no existe en el tipo ${spec.length > 0 ? 'indicado' : 'seleccionado'}: revisar la configuración)`,
            );

            continue;
        }

        const value = fields[field.id];

        // Un campo presente pero sin contenido es tan olvido como uno ausente,
        // y además engaña: aparenta haberse rellenado.
        if (
            value === undefined ||
            value === null ||
            value === '' ||
            (Array.isArray(value) && value.length === 0)
        ) {
            missing.push(`"${field.name}" (${field.id})`);
        }
    }

    if (missing.length > 0) {
        throw new Error(
            `El proyecto ${projectKey} exige por convención del equipo campos que Jira no marca como obligatorios y cuya ausencia no señala: ${missing.join(', ')}. Configurado en JIRA_REQUIRED_FIELDS_${projectKey.toUpperCase()}.`,
        );
    }
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

        return {
            key,
            url: `${client.defaults.baseURL}/browse/${key}`,
            applied,
            ...(watchers !== undefined && { watchers }),
        };
    } catch (error) {
        handleJiraError(error);
    }
}
