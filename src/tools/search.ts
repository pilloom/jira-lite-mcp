import { z } from 'zod';

import { searchIssues } from '../jira/search.js';

export const searchTool = {
    name: 'jira_search',

    description:
        'Busca issues en Jira usando una consulta JQL. Útil para encontrar tickets por proyecto, estado, asignación, sprint, etc. De cada issue devuelve clave, título, estado y asignado; cualquier otro campo —incluida la DESCRIPCIÓN, que no viene por defecto porque pesa más que todo lo demás junto— hay que nombrarlo en "fields". Un issue sin ese campo no interrumpe la búsqueda, se informa en "warning". Devuelve los issues de una página junto con si quedan más resultados en "hasMore": la API de búsqueda no informa del total de coincidencias, y para traer más hay que subir "limit".',

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
                'Número máximo de issues a devolver. Por defecto 20, y se puede subir: es lo que hay que hacer para abarcar un conjunto más grande, porque esta herramienta no pagina',
            ),
        fields: z
            .array(z.string())
            .optional()
            .describe(
                'Campos a incluir en cada issue además de clave, título, estado y asignado, por su nombre visible o su identificador. Ejemplo: ["Criterios de aceptación"]. "description" trae la descripción, que no viene por defecto',
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
