import { adfToText } from './adf.js';
import { createJiraClient } from './client.js';
import { handleJiraError } from './error.js';
import { findField, readFieldValue } from './fields.js';
import { getAllFields } from './meta.js';

import type { JiraIssue } from '../types/jira.js';

interface JiraApiIssueResponse {
    key: string;
    fields: {
        summary: string;
        status: { name: string };
        issuetype: { name: string };
        priority: { name: string } | null;
        assignee: { displayName: string } | null;
        parent?: {
            key: string;
            fields: { summary: string };
        };
        labels: string[];
        created: string;
        updated: string;
        timetracking?: {
            originalEstimate?: string;
            timeSpent?: string;
        };
        /** Documento ADF: la API v3 nunca devuelve texto plano aquí. */
        description: unknown;
        [key: string]: unknown;
    };
}

const BASE_FIELDS = [
    'summary',
    'status',
    'issuetype',
    'priority',
    'assignee',
    'parent',
    'labels',
    'created',
    'updated',
    'timetracking',
    'description',
];

/**
 * Resuelve por su nombre los campos adicionales pedidos. Al leer un issue no
 * hay pantalla que acote los disponibles, así que se buscan en el catálogo
 * completo de la instancia.
 */
async function resolveExtraFields(
    names: string[],
): Promise<Array<{ id: string; name: string }>> {
    if (names.length === 0) {
        return [];
    }

    const catalog = await getAllFields();

    return names.map((name) => {
        const field = findField(catalog, name);

        if (!field) {
            throw new Error(
                `El campo "${name}" no existe en esta instancia de Jira.`,
            );
        }

        return { id: field.id, name: field.name };
    });
}

export async function getIssue(
    issueKey: string,
    extraFieldNames: string[] = [],
): Promise<JiraIssue> {
    try {
        const extra = await resolveExtraFields(extraFieldNames);

        const client = createJiraClient();

        const response = await client.get<JiraApiIssueResponse>(
            `/rest/api/3/issue/${issueKey}`,
            {
                params: {
                    fields: [...BASE_FIELDS, ...extra.map((f) => f.id)].join(
                        ',',
                    ),
                },
            },
        );

        const fields = response.data.fields;

        const custom: Record<string, unknown> = {};

        for (const field of extra) {
            custom[field.name] = readFieldValue(fields[field.id]);
        }

        return {
            key: response.data.key,
            url: `${client.defaults.baseURL}/browse/${response.data.key}`,
            summary: fields.summary,
            type: fields.issuetype.name,
            status: fields.status.name,
            priority: fields.priority?.name ?? null,
            assignee: fields.assignee?.displayName ?? null,
            parent: fields.parent
                ? {
                      key: fields.parent.key,
                      summary: fields.parent.fields.summary,
                  }
                : null,
            labels: fields.labels,
            created: fields.created.slice(0, 10),
            updated: fields.updated.slice(0, 10),
            originalEstimate: fields.timetracking?.originalEstimate ?? null,
            timeSpent: fields.timetracking?.timeSpent ?? null,
            description: adfToText(fields.description),
            ...(extra.length > 0 && { customFields: custom }),
        };
    } catch (error) {
        handleJiraError(error);
    }
}
