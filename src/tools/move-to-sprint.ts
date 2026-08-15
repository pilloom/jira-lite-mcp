import { z } from 'zod';

import { moveIssuesToSprint } from '../jira/sprints.js';

export const moveToSprintTool = {
    name: 'jira_move_to_sprint',

    description:
        'Mueve issues a un sprint. El sprint se indica por su identificador o por su nombre; por nombre hace falta también el proyecto, porque el nombre solo es único dentro de su tablero. Un issue pertenece a un solo sprint, así que moverlo lo saca del anterior. La respuesta dice qué issues se movieron realmente: la API los envía en lotes de 50 y uno puede fallar sin afectar al resto.',

    inputSchema: z.object({
        sprint: z
            .string()
            .describe(
                'Identificador del sprint o su nombre. Ejemplo: 42, "Sprint 12"',
            ),
        issues: z
            .array(z.string())
            .describe('Claves de los issues a mover. Ejemplo: ["ATY-1", "ATY-2"]'),
        project: z
            .string()
            .optional()
            .describe(
                'Clave del proyecto, para localizar el tablero cuando el sprint se indica por su nombre',
            ),
        boardId: z
            .number()
            .optional()
            .describe(
                'Identificador del tablero, necesario solo si el proyecto tiene más de uno',
            ),
    }),

    async handler(args: {
        sprint: string;
        issues: string[];
        project?: string;
        boardId?: number;
    }) {
        const result = await moveIssuesToSprint(args.sprint, args.issues, {
            project: args.project,
            boardId: args.boardId,
        });

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
