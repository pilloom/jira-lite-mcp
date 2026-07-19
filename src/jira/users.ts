import { createJiraClient } from './client.js';
import { handleJiraError } from './error.js';

import type { JiraUser } from '../types/jira.js';

interface JiraApiUserResponse {
    accountId: string;
    displayName: string;
    emailAddress?: string;
}

export async function getCurrentUser(): Promise<JiraUser> {
    try {
        const client = createJiraClient();

        const response = await client.get<JiraApiUserResponse>(
            '/rest/api/3/myself',
        );

        return {
            accountId: response.data.accountId,
            displayName: response.data.displayName,
            email: response.data.emailAddress ?? null,
        };
    } catch (error) {
        handleJiraError(error);
    }
}
