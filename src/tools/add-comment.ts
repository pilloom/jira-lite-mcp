import { z } from 'zod';

import { addComment } from '../jira/comments.js';

export const addCommentTool = {
    name: 'jira_add_comment',

    description:
        'Añade un comentario a un issue de Jira. El texto admite markdown —listas de tareas, listas, encabezados, negrita, código, enlaces y menciones— y se convierte al formato que espera la API, conservando los saltos de línea. Para mencionar a alguien, @[correo, nombre o accountId]: se resuelve a la persona y Jira le avisa; si no designa a nadie o a varias, no se escribe nada.',

    inputSchema: z.strictObject({
        issueKey: z.string().describe('Clave del issue. Ejemplo: ATY-123'),
        body: z.string().describe('Texto del comentario, en markdown. Ejemplo: Revisado, @[ana@empresa.com] lo despliega'),
    }),

    async handler(args: { issueKey: string; body: string }) {
        const result = await addComment(args.issueKey, args.body);

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
