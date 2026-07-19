import { z } from 'zod';

import { deleteResource } from '../jira/delete.js';

import type { JiraDeletableType } from '../types/jira.js';

export const deleteTool = {
    name: 'jira_delete',

    description:
        'Elimina de forma permanente un comentario, un registro de tiempo o un enlace entre issues. Los identificadores se obtienen de jira_explain_issue (comentarios y enlaces) o de jira_get_worklog. No permite eliminar issues: para retirar uno de la circulación, moverlo a un estado final con jira_transition_issue.',

    inputSchema: z.object({
        type: z
            .enum(['comment', 'worklog', 'link'])
            .describe('Qué se elimina: comentario, registro de tiempo o enlace'),
        // Los identificadores de Jira son cadenas de dígitos, así que se
        // acepta también un número: es una confusión fácil al leerlos de una
        // respuesta previa y no hay ambigüedad al convertirlo.
        id: z
            .union([z.string(), z.number()])
            .describe('Identificador del elemento a eliminar'),
        issueKey: z
            .string()
            .optional()
            .describe(
                'Clave del issue al que pertenece. Obligatorio para comentarios y registros de tiempo; innecesario para enlaces',
            ),
    }),

    async handler(args: {
        type: JiraDeletableType;
        id: string | number;
        issueKey?: string;
    }) {
        const result = await deleteResource(
            args.type,
            String(args.id),
            args.issueKey,
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
