import { textToAdf } from './adf.js';
import { createJiraClient } from './client.js';
import { handleJiraError } from './error.js';
import { buildCustomFields } from './fields.js';
import { getIssueTypeFields } from './meta.js';

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

    if (input.assignee !== undefined) {
        fields.assignee = { id: input.assignee };
    }

    if (input.priority !== undefined) {
        fields.priority = { name: input.priority };
    }

    if (input.labels !== undefined) {
        fields.labels = input.labels;
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

export async function createIssue(
    input: JiraCreateIssueInput,
): Promise<JiraCreatedIssue> {
    try {
        // El esquema se consulta antes de escribir: valida el payload y aporta
        // el tipo real de cada campo, que determina cómo serializarlo.
        const meta = await getIssueTypeFields(input.project, input.issueType);

        const fields = buildFields(
            { ...input, issueType: meta.issueType },
            meta.fields,
        );

        const client = createJiraClient();

        const response = await client.post<JiraApiCreatedIssueResponse>(
            '/rest/api/3/issue',
            { fields },
        );

        return {
            key: response.data.key,
            url: `${client.defaults.baseURL}/browse/${response.data.key}`,
        };
    } catch (error) {
        handleJiraError(error);
    }
}
