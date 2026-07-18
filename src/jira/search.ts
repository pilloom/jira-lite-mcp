import { createJiraClient } from './client.js';
import { handleJiraError } from './error.js';

import type { JiraIssue, JiraSearchResult } from '../types/jira.js';

interface JiraSearchResponse {
    total: number;
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
            description: string | null;
        };
    }>;
}

export async function searchIssues(jql: string): Promise<JiraSearchResult> {
    try {
        const client = createJiraClient();

        const response = await client.post<JiraSearchResponse>(
            '/rest/api/3/search/jql',
            {
                jql,
                maxResults: 20,
                fields: [
                    'summary',
                    'status',
                    'assignee',
                    'description',
                ],
            },
        );

        const issues: JiraIssue[] = response.data.issues.map((issue) => ({
            key: issue.key,
            summary: issue.fields.summary,
            status: issue.fields.status.name,
            assignee: issue.fields.assignee?.displayName ?? null,
            description: issue.fields.description,
        }));

        return {
            total: response.data.total,
            issues,
        };
    } catch (error) {
        handleJiraError(error);
    }
}