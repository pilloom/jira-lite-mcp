import { z } from 'zod';

import { getIssueTypeFields, getIssueTypes } from '../jira/meta.js';

export const issueFieldsTool = {
    name: 'jira_issue_fields',

    description:
        'Devuelve los tipos de issue de un proyecto de Jira y, si se indica un tipo, los campos que admite al crearlo: identificador, nombre, si es obligatorio, tipo de dato y valores permitidos. Útil para conocer los campos reales de la instancia antes de crear un issue.',

    inputSchema: z.object({
        project: z
            .string()
            .describe('Clave del proyecto de Jira. Ejemplo: ATY'),
        issueType: z
            .string()
            .optional()
            .describe(
                'Nombre o id del tipo de issue. Ejemplo: Historia. Si se omite, se devuelven los tipos disponibles del proyecto.',
            ),
    }),

    async handler(args: { project: string; issueType?: string }) {
        const result = args.issueType
            ? await getIssueTypeFields(args.project, args.issueType)
            : await getIssueTypes(args.project);

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
