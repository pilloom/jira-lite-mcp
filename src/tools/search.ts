import { z } from 'zod';

import { searchIssues } from '../jira/search.js';

export const searchTool = {
    name: 'jira_search',

    description:
        'Busca issues en Jira usando una consulta JQL. Útil para encontrar tickets por proyecto, estado, asignación, sprint, etc. Devuelve los issues de una página junto con si quedan más resultados; la API de búsqueda no informa del total de coincidencias.',

    inputSchema: z.object({
        jql: z
            .string()
            .describe(
                'Consulta JQL de Jira. Ejemplo: project = ATY AND status != Done',
            ),
        limit: z
            .number()
            .optional()
            .describe('Número máximo de issues a devolver. Por defecto 20'),
    }),

    async handler(args: { jql: string; limit?: number }) {
        const result = await searchIssues(args.jql, args.limit);

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