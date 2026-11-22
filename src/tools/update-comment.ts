import { z } from 'zod';

import { updateComment } from '../jira/comments.js';

export const updateCommentTool = {
    name: 'jira_update_comment',

    description:
        'Reescribe un comentario de un issue. El texto nuevo sustituye entero al anterior, en markdown como en jira_add_comment, menciones incluidas. Jira solo deja editar los comentarios propios, salvo permiso para editar todos. El identificador del comentario lo devuelven jira_add_comment y jira_explain_issue.',

    inputSchema: z.strictObject({
        issueKey: z.string().describe('Clave del issue. Ejemplo: ATY-123'),
        commentId: z
            .string()
            .describe('Identificador del comentario. Ejemplo: 10452'),
        body: z
            .string()
            .describe('Texto completo nuevo del comentario, en markdown'),
    }),

    async handler(args: { issueKey: string; commentId: string; body: string }) {
        const result = await updateComment(
            args.issueKey,
            args.commentId,
            args.body,
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
