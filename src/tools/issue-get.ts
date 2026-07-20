import { z } from 'zod';

import { getIssue } from '../jira/issues.js';

export const issueGetTool = {
    name: 'jira_get_issue',

    description:
        'Obtiene un issue de Jira por su clave: título, tipo, estado, prioridad, responsable, issue padre, etiquetas, fechas, estimación y tiempo dedicado, descripción y enlace web. Admite pedir campos adicionales por su nombre. Para subtareas, enlaces y comentarios, usar jira_explain_issue.',

    inputSchema: z.object({
        issueKey: z.string().describe('Clave del issue de Jira'),
        fields: z
            .array(z.string())
            .optional()
            .describe(
                'Campos adicionales a incluir, por su nombre visible. Ejemplo: ["Team", "Criterios de aceptación"]',
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