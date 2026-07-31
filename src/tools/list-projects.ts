import { z } from 'zod';

import { listProjects } from '../jira/projects.js';

import type { ListProjectsOptions } from '../jira/projects.js';

export const listProjectsTool = {
    name: 'jira_list_projects',

    description:
        'Lista los proyectos de Jira visibles para la cuenta autenticada, con su clave, nombre, tipo y responsable. Sirve para averiguar la clave de un proyecto a partir de su nombre, que es lo que necesitan el resto de herramientas.',

    inputSchema: z.object({
        query: z
            .string()
            .optional()
            .describe(
                'Filtra por texto contenido en el nombre o en la clave del proyecto. Si se omite, devuelve todos',
            ),
        limit: z
            .number()
            .optional()
            .describe('Número máximo de proyectos a devolver. Por defecto 50'),
    }),

    async handler(args: ListProjectsOptions) {
        const result = await listProjects(args);

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
