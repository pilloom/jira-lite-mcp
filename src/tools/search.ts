import { z } from 'zod';

import { searchIssues } from '../jira/search.js';

export const searchTool = {
    name: 'jira_search',

    description:
        'Busca issues en Jira usando una consulta JQL. Útil para encontrar tickets por proyecto, estado, asignación, sprint, etc. Devuelve los issues de una página junto con si quedan más resultados; la API de búsqueda no informa del total de coincidencias. Los campos personalizados no se devuelven si no se piden: hay que nombrarlos en "fields", y un issue sin ese campo no interrumpe la búsqueda, se informa en "warning".',

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
        fields: z
            .array(z.string())
            .optional()
            .describe(
                'Campos adicionales a incluir en cada issue, por su nombre visible o su identificador. Ejemplo: ["Criterios de aceptación"]',
            ),
    }),

    async handler(args: { jql: string; limit?: number; fields?: string[] }) {
        const result = await searchIssues(args.jql, args.limit, args.fields);

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
