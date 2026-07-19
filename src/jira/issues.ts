import { adfToText } from './adf.js';
import { createJiraClient } from './client.js';
import { handleJiraError } from './error.js';

import type { JiraIssue } from '../types/jira.js';

interface JiraApiIssueResponse {
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
}

export async function getIssue(issueKey: string): Promise<JiraIssue> {
    try {
        const client = createJiraClient();

        const response = await client.get<JiraApiIssueResponse>(
            `/rest/api/3/issue/${issueKey}`,
        );

        return {
            key: response.data.key,
            summary: response.data.fields.summary,
            status: response.data.fields.status.name,
            assignee: response.data.fields.assignee?.displayName ?? null,
            description: adfToText(response.data.fields.description),
        };
    } catch (error) {
        handleJiraError(error);
    }
}