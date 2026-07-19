import { z } from 'zod';

import { addWorklog } from '../jira/worklog.js';

import type { WorklogInput } from '../jira/worklog.js';

export const addWorklogTool = {
    name: 'jira_add_worklog',

    description:
        'Registra tiempo trabajado en un issue de Jira. La respuesta incluye cómo ha interpretado Jira el tiempo enviado, en segundos, porque la duración de una jornada la define la configuración del sitio.',

    inputSchema: z.object({
        issueKey: z.string().describe('Clave del issue. Ejemplo: ATY-123'),
        timeSpent: z
            .string()
            .describe(
                'Tiempo trabajado en el formato de Jira. Ejemplos: 30m, 1h 30m, 8h',
            ),
        comment: z
            .string()
            .optional()
            .describe('Descripción del trabajo realizado'),
        started: z
            .string()
            .optional()
            .describe(
                'Momento en que se realizó el trabajo, en formato ISO. Ejemplo: 2026-07-19T09:00:00. Por defecto, ahora',
            ),
    }),

    async handler(args: WorklogInput) {
        const result = await addWorklog(args);

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
