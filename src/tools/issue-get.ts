import { z } from 'zod';

import { getIssue } from '../jira/issues.js';

export const issueGetTool = {
    name: 'jira_get_issue',

    description:
        'Obtiene un issue de Jira por su clave: título, tipo, estado, prioridad, responsable, issue padre, etiquetas, fechas, estimación y tiempo dedicado, descripción y enlace web. Los campos personalizados no se devuelven si no se piden: hay que nombrarlos en "fields", y su ausencia en la respuesta no significa que el issue no los tenga. Si varios campos de la instancia comparten ese nombre y más de uno aplica al issue, el error enumera sus identificadores en lugar de devolver un valor vacío. Los campos de texto rico se devuelven en markdown, con su estructura: listas de tareas con el estado de cada casilla, listas, encabezados, negrita y código. Para subtareas, enlaces y comentarios, usar jira_explain_issue.',

    inputSchema: z.strictObject({
        issueKey: z.string().describe('Clave del issue de Jira'),
        fields: z
            .array(z.string())
            .optional()
            .describe(
                'Campos adicionales a incluir, por su nombre visible o su identificador. Ejemplo: ["Team", "Criterios de aceptación"]',
            ),
    }),

    async handler(args: { issueKey: string; fields?: string[] }) {
        const issue = await getIssue(args.issueKey, args.fields);

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