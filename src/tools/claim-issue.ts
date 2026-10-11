import { z } from 'zod';

import { claimIssue } from '../jira/claim.js';
import { strictToolSchema } from './params.js';

export const claimIssueTool = {
    name: 'jira_claim_issue',

    description:
        'Toma una tarea para uno mismo con comprobación previa y confirmación posterior: lee el issue en Jira, se detiene si ya tiene dueño, si está cerrada o si está sin asignar pero ya empezada, y si está libre se la asigna a la cuenta del token y vuelve a leerla para confirmar que quedó a su nombre. Si dos personas la toman a la vez, quien pierde se entera por esa relectura en lugar de hacer el trabajo por duplicado. Opcionalmente transiciona de estado, solo si ganó la asignación. Es la forma de empezar una tarea: no usar jira_update_issue para asignarse algo, porque no comprueba nada.',

    inputSchema: strictToolSchema({
        issueKey: z.string().describe('Clave del issue. Ejemplo: LAN-2796'),
        to: z
            .string()
            .optional()
            .describe(
                'Estado al que pasarla tras tomarla, por el nombre del estado o de la transición. Ejemplo: En curso. Si se omite, solo se asigna',
            ),
    }),

    async handler(args: { issueKey: string; to?: string }) {
        const result = await claimIssue(args.issueKey, args.to);

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
