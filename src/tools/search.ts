import { z } from 'zod';

import { searchIssues } from '../jira/search.js';

export const searchTool = {
    name: 'jira_search',

    description:
        'Busca issues en Jira usando una consulta JQL. Útil para encontrar tickets por proyecto, estado, asignación, sprint, etc. De cada issue devuelve clave, título, estado y asignado; cualquier otro campo —incluida la DESCRIPCIÓN, que no viene por defecto porque pesa más que todo lo demás junto— hay que nombrarlo en "fields". Un issue sin ese campo no interrumpe la búsqueda, se informa en "warning". "total" dice cuántos issues cumplen la consulta entera y "count" cuántos trae esta página; si "hasMore" es cierto, se pasa el "cursor" que devuelve para traer la siguiente, y así hasta que no venga ninguno.',

    inputSchema: z.strictObject({
        jql: z
            .string()
            .describe(
                'Consulta JQL de Jira. Ejemplo: project = ATY AND status != Done',
            ),
        limit: z
            .number()
            .optional()
            .describe(
                'Número máximo de issues por página. Por defecto 20. Subirlo trae más de una vez; para recorrer un conjunto entero está "cursor"',
            ),
        fields: z
            .array(z.string())
            .optional()
            .describe(
                'Campos a incluir en cada issue además de clave, título, estado y asignado, por su nombre visible o su identificador. Ejemplo: ["Criterios de aceptación"]. "description" trae la descripción, que no viene por defecto',
            ),
        cursor: z
            .string()
            .optional()
            .describe(
                'Continúa desde donde acabó la llamada anterior: el valor de "cursor" que devolvió. Hay que repetir el mismo "jql", y conviene que lleve un ORDER BY para que el recorrido no dependa del orden que elija Jira',
            ),
    }),

    async handler(args: {
        jql: string;
        limit?: number;
        fields?: string[];
        cursor?: string;
    }) {
        const result = await searchIssues(
            args.jql,
            args.limit,
            args.fields,
            args.cursor,
        );

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
