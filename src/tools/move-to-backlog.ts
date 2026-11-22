import { z } from 'zod';

import { moveIssuesToBacklog } from '../jira/sprints.js';

export const moveToBacklogTool = {
    name: 'jira_move_to_backlog',

    description:
        'Devuelve issues al backlog: los saca del sprint activo o futuro en que estén. Los sprints cerrados no se tocan, porque son historial. Para meterlos en un sprint, jira_move_to_sprint. La respuesta dice qué issues se movieron realmente: la API los envía en lotes de 50 y uno puede fallar sin afectar al resto.',

    inputSchema: z.strictObject({
        issues: z
            .array(z.string())
            .describe('Claves de los issues a devolver al backlog. Ejemplo: ["ATY-1", "ATY-2"]'),
    }),

    async handler(args: { issues: string[] }) {
        const result = await moveIssuesToBacklog(args.issues);

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
