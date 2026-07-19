import { z } from 'zod';

import { getMyWork } from '../jira/my-work.js';

import type { MyWorkOptions } from '../jira/my-work.js';

export const myWorkTool = {
    name: 'jira_my_work',

    description:
        'Devuelve los issues asignados al usuario autenticado que siguen pendientes, ordenados por fecha de actualización. Responde a preguntas como "¿qué tengo pendiente en Jira?". Cada issue incluye clave, título, tipo, estado, prioridad y fecha de última actualización.',

    inputSchema: z.object({
        project: z
            .string()
            .optional()
            .describe(
                'Limita el resultado a un proyecto. Ejemplo: ATY. Si se omite, busca en todos',
            ),
        limit: z
            .number()
            .optional()
            .describe('Número máximo de issues a devolver. Por defecto 20'),
        includeDone: z
            .boolean()
            .optional()
            .describe(
                'Incluye también los issues ya terminados. Por defecto false',
            ),
    }),

    async handler(args: MyWorkOptions) {
        const result = await getMyWork(args);

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
