import { z } from 'zod';

import { updateIssue } from '../jira/update.js';

import type { JiraUpdateIssueInput } from '../types/jira.js';

export const updateIssueTool = {
    name: 'jira_update_issue',

    description:
        'Actualiza los campos de un issue de Jira. Solo se envían los campos indicados; el resto queda intacto. Valida contra los campos que el issue admite editar, de modo que un campo no editable produce un error en lugar de descartarse en silencio. Los campos personalizados se indican por su nombre visible o por su identificador.',

    inputSchema: z.object({
        issueKey: z.string().describe('Clave del issue. Ejemplo: ATY-123'),
        summary: z.string().optional().describe('Nuevo título del issue'),
        description: z
            .string()
            .optional()
            .describe('Nueva descripción en texto plano'),
        assignee: z
            .string()
            .optional()
            .describe('accountId de la persona asignada'),
        priority: z
            .string()
            .optional()
            .describe('Nombre de la prioridad. Ejemplo: High'),
        labels: z
            .array(z.string())
            .optional()
            .describe('Etiquetas del issue. Reemplazan a las existentes'),
        customFields: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
                'Campos personalizados por nombre o identificador. Ejemplo: { "Criterios de aceptación": "[ ] Primero" }',
            ),
    }),

    async handler(args: JiraUpdateIssueInput) {
        const result = await updateIssue(args);

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
