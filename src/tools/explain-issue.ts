import { z } from 'zod';

import { explainIssue } from '../jira/explain.js';

export const explainIssueTool = {
    name: 'jira_explain_issue',

    description:
        'Devuelve un issue con todo su contexto en una sola llamada: descripción en texto legible, issue padre, subtareas, issues enlazados, comentarios recientes y estados a los que puede moverse. Admite pedir campos adicionales por su nombre. Pensado para entender un ticket completo sin encadenar varias consultas.',

    inputSchema: z.object({
        issueKey: z.string().describe('Clave del issue. Ejemplo: ATY-123'),
        extraFields: z
            .array(z.string())
            .optional()
            .describe(
                'Campos adicionales a incluir, por su nombre visible. Ejemplo: ["Criterios de aceptación"]',
            ),
    }),

    async handler(args: { issueKey: string; extraFields?: string[] }) {
        const result = await explainIssue(args.issueKey, args.extraFields);

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
