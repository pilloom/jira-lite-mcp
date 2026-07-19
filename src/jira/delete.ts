import { createJiraClient } from './client.js';
import { handleJiraError } from './error.js';

import type { JiraDeleteResult, JiraDeletableType } from '../types/jira.js';

/**
 * Elimina un elemento asociado a un issue. Deliberadamente no permite borrar
 * issues: eso destruye trabajo registrado —junto con sus subtareas— y deja un
 * hueco permanente en la numeración del proyecto. Para retirar un issue de la
 * circulación existe la transición a un estado final.
 */
export async function deleteResource(
    type: JiraDeletableType,
    id: string,
    issueKey?: string,
): Promise<JiraDeleteResult> {
    try {
        const client = createJiraClient();

        if (type === 'link') {
            await client.delete(`/rest/api/3/issueLink/${id}`);

            return { deleted: type, id };
        }

        if (issueKey === undefined) {
            throw new Error(
                `Para eliminar un ${type === 'comment' ? 'comentario' : 'registro de tiempo'} hace falta la clave del issue al que pertenece.`,
            );
        }

        const path = type === 'comment' ? 'comment' : 'worklog';

        await client.delete(`/rest/api/3/issue/${issueKey}/${path}/${id}`);

        return { deleted: type, id, issueKey };
    } catch (error) {
        handleJiraError(error);
    }
}
