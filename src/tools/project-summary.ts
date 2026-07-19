import { z } from 'zod';

import { getProjectSummary } from '../jira/project-summary.js';

import type { ProjectSummaryOptions } from '../jira/project-summary.js';

export const projectSummaryTool = {
    name: 'jira_project_summary',

    description:
        'Resume el estado de un proyecto de Jira a partir de sus issues abiertos: cuántos hay, cómo se reparten por estado, tipo y prioridad, cuántos están sin asignar y cuántos llevan tiempo sin actualizarse. Devuelve datos agregados, no una valoración.',

    inputSchema: z.object({
        project: z
            .string()
            .describe('Clave del proyecto de Jira. Ejemplo: ATY'),
        staleDays: z
            .number()
            .optional()
            .describe(
                'Días sin actualización a partir de los cuales un issue se considera estancado. Por defecto 14',
            ),
    }),

    async handler(args: ProjectSummaryOptions) {
        const result = await getProjectSummary(args);

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
