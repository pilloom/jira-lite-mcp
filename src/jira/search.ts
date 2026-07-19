import { adfToText } from './adf.js';
import { createJiraClient } from './client.js';
import { handleJiraError } from './error.js';

import type { JiraIssue, JiraSearchResult } from '../types/jira.js';

interface JiraSearchResponse {
    issues: Array<{
        key: string;
        fields: {
            summary: string;
            status: {
                name: string;
            };
            assignee: {
                displayName: string;
            } | null;
            /** Documento ADF: la API v3 nunca devuelve texto plano aquí. */
            description: unknown;
        };
    }>;
    /** Ausente cuando la página devuelta es la última. */
    nextPageToken?: string;
    isLast?: boolean;
}

const DEFAULT_LIMIT = 20;

export async function searchIssues(
    jql: string,
    limit: number = DEFAULT_LIMIT,
): Promise<JiraSearchResult> {
    try {
        const client = createJiraClient();

        const response = await client.post<JiraSearchResponse>(
            '/rest/api/3/search/jql',
            {
                jql,
                maxResults: limit,
                fields: ['summary', 'status', 'assignee', 'description'],
            },
        );

        const issues: JiraIssue[] = response.data.issues.map((issue) => ({
            key: issue.key,
            summary: issue.fields.summary,
            status: issue.fields.status.name,
            assignee: issue.fields.assignee?.displayName ?? null,
            description: adfToText(issue.fields.description),
        }));

        return {
            count: issues.length,
            // Este endpoint no devuelve el total de coincidencias: pagina con
            // `nextPageToken`. Se informa de si quedan resultados en lugar de
            // inventar un total que la API ya no da.
            hasMore: response.data.isLast === false ||
                response.data.nextPageToken !== undefined,
            issues,
        };
    } catch (error) {
        handleJiraError(error);
    }
}
