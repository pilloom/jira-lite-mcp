import { z } from 'zod';

import { transitionIssue } from '../jira/transitions.js';

export const transitionIssueTool = {
    name: 'jira_transition_issue',

    description:
        'Cambia el estado de un issue de Jira. El destino se indica por el nombre del estado, por el nombre de la transición o por su id, y se resuelve contra las transiciones que el issue admite en ese momento. Si el destino no es válido, la respuesta enumera los estados posibles. Admite un comentario en la misma operación.',

    inputSchema: z.object({
        issueKey: z.string().describe('Clave del issue. Ejemplo: ATY-123'),
        to: z
            .string()
            .describe(
                'Estado o transición de destino. Ejemplo: En curso, Finalizada, o el id de la transición',
            ),
        comment: z
            .string()
            .optional()
            .describe('Comentario a añadir junto con el cambio de estado'),
    }),

    async handler(args: { issueKey: string; to: string; comment?: string }) {
        const result = await transitionIssue(
            args.issueKey,
            args.to,
            args.comment,
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
