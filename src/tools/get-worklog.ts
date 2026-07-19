import { z } from 'zod';

import { getWorklog } from '../jira/worklog.js';

export const getWorklogTool = {
    name: 'jira_get_worklog',

    description:
        'Devuelve el tiempo registrado en un issue de Jira: la estimación original, el total dedicado y cada registro con su autor, duración, fecha y descripción. Incluye el identificador de cada registro, necesario para eliminarlo.',

    inputSchema: z.object({
        issueKey: z.string().describe('Clave del issue. Ejemplo: ATY-123'),
    }),

    async handler(args: { issueKey: string }) {
        const result = await getWorklog(args.issueKey);

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
