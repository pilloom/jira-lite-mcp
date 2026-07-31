import { createJiraClient } from './client.js';
import { handleJiraError } from './error.js';

import type { JiraProject, JiraProjectList } from '../types/jira.js';

interface JiraProjectSearchResponse {
    values: Array<{
        key: string;
        name: string;
        projectTypeKey: string;
        lead?: {
            displayName: string;
        };
    }>;
    /** Este endpoint sí informa del total de coincidencias, a diferencia del de JQL. */
    total: number;
}

const DEFAULT_LIMIT = 50;

/** Tope por página del endpoint: pedir más no devuelve más. */
const PAGE_SIZE = 50;

export interface ListProjectsOptions {
    query?: string;
    limit?: number;
}

/**
 * Lista los proyectos visibles para la cuenta autenticada.
 *
 * Es el punto de entrada cuando no se conoce la clave de un proyecto: el resto
 * de herramientas la exigen, y sin esta habría que adivinarla o pedírsela a
 * quien pregunta.
 */
export async function listProjects(
    options: ListProjectsOptions = {},
): Promise<JiraProjectList> {
    const limit = options.limit ?? DEFAULT_LIMIT;

    try {
        const client = createJiraClient();

        const projects: JiraProject[] = [];

        let total = 0;

        while (projects.length < limit) {
            const response = await client.get<JiraProjectSearchResponse>(
                '/rest/api/3/project/search',
                {
                    params: {
                        startAt: projects.length,
                        maxResults: Math.min(PAGE_SIZE, limit - projects.length),
                        // El responsable no viene en la respuesta base.
                        expand: 'lead',
                        ...(options.query !== undefined && {
                            query: options.query,
                        }),
                    },
                },
            );

            total = response.data.total;

            if (response.data.values.length === 0) {
                break;
            }

            projects.push(
                ...response.data.values.map((project) => ({
                    key: project.key,
                    name: project.name,
                    type: project.projectTypeKey,
                    lead: project.lead?.displayName ?? null,
                })),
            );
        }

        return {
            count: projects.length,
            total,
            hasMore: projects.length < total,
            projects,
        };
    } catch (error) {
        handleJiraError(error);
    }
}
