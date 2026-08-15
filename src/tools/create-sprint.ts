import { z } from 'zod';

import { createSprint } from '../jira/sprints.js';

import type { JiraCreateSprintInput } from '../types/jira.js';

export const createSprintTool = {
    name: 'jira_create_sprint',

    description:
        'Crea un sprint en el tablero scrum de un proyecto. El tablero se resuelve a partir de la clave del proyecto; si tiene varios, la respuesta enumera sus identificadores para elegir uno con boardId. El sprint queda en estado "future": crearlo no lo arranca. Para meterle issues, jira_move_to_sprint.',

    inputSchema: z.object({
        project: z
            .string()
            .optional()
            .describe(
                'Clave del proyecto cuyo tablero scrum alojará el sprint. Ejemplo: ATY',
            ),
        boardId: z
            .number()
            .optional()
            .describe(
                'Identificador del tablero, necesario solo si el proyecto tiene más de uno',
            ),
        name: z
            .string()
            .describe('Nombre del sprint. Ejemplo: Sprint 12'),
        startDate: z
            .string()
            .optional()
            .describe(
                'Fecha de inicio: 2026-08-15 o 2026-08-15T09:00:00.000Z. Una fecha sin hora se ancla a medianoche UTC',
            ),
        endDate: z
            .string()
            .optional()
            .describe('Fecha de fin, en el mismo formato que la de inicio'),
        goal: z
            .string()
            .optional()
            .describe('Objetivo del sprint'),
    }),

    async handler(args: JiraCreateSprintInput) {
        const result = await createSprint(args);

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
