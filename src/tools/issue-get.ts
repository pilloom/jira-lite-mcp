import { z } from 'zod';

import { getIssue } from '../jira/issues.js';

export const issueGetTool = {
    name: 'jira_get_issue',

    description:
        'Obtiene información de un issue de Jira usando su clave, por ejemplo ATY-123.',

    inputSchema: z.object({
        issueKey: z.string().describe('Clave del issue de Jira'),
    }),

    async handler(args: { issueKey: string }) {
        const issue = await getIssue(args.issueKey);

        return {
            content: [
                {
                    type: 'text' as const,
                    text: JSON.stringify(issue, null, 2),
                },
            ],
        };
    },
};