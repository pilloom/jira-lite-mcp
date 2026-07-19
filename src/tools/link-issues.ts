import { z } from 'zod';

import { linkIssues } from '../jira/links.js';

export const linkIssuesTool = {
    name: 'jira_link_issues',

    description:
        'Enlaza dos issues de Jira. La relación se indica tal como se enuncia, desde el primer issue hacia el segundo: "blocks", "is blocked by", "relates to", "duplicates". Se resuelve contra los tipos de enlace de la instancia y, si no existe, la respuesta enumera las relaciones posibles.',

    inputSchema: z.object({
        issueKey: z
            .string()
            .describe('Clave del issue de origen. Ejemplo: ATY-123'),
        relation: z
            .string()
            .describe(
                'Relación desde el issue de origen hacia el de destino. Ejemplo: relates to, blocks, is blocked by',
            ),
        targetKey: z
            .string()
            .describe('Clave del issue de destino. Ejemplo: ATY-456'),
    }),

    async handler(args: {
        issueKey: string;
        relation: string;
        targetKey: string;
    }) {
        const result = await linkIssues(
            args.issueKey,
            args.relation,
            args.targetKey,
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
