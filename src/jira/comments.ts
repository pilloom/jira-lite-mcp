import { textToAdf } from './adf.js';
import { createJiraClient } from './client.js';
import { handleJiraError } from './error.js';

import type { JiraCommentResult } from '../types/jira.js';

interface JiraApiCommentResponse {
    id: string;
    created: string;
}

export async function addComment(
    issueKey: string,
    body: string,
): Promise<JiraCommentResult> {
    try {
        const client = createJiraClient();

        const response = await client.post<JiraApiCommentResponse>(
            `/rest/api/3/issue/${issueKey}/comment`,
            { body: textToAdf(body) },
        );

        return {
            key: issueKey,
            id: response.data.id,
            created: response.data.created.slice(0, 10),
        };
    } catch (error) {
        handleJiraError(error);
    }
}
