import { z } from 'zod';

import { searchIssues } from '../jira/search.js';

export const searchTool = {
    name: 'jira_search',

    description:
        'Busca issues en Jira usando una consulta JQL. Útil para encontrar tickets por proyecto, estado, asignación, sprint, etc.',

    inputSchema: z.object({
        jql: z
            .string()
            .describe(
                'Consulta JQL de Jira. Ejemplo: project = ATY AND status != Done',
            ),
    }),

    async handler(args: { jql: string }) {
        const result = await searchIssues(args.jql);

        return {
            content: [
                {
                    type: 'text' as const,
                    text: JSON.stringify(result, null, 2),
                },
            ],
        };
    },
};