import { createJiraClient } from './client.js';
import { handleJiraError } from './error.js';
import { markdownToAdf } from './markdown.js';
import { resolveMentions } from './mentions.js';

import type {
    JiraCommentResult,
    JiraCommentUpdateResult,
} from '../types/jira.js';

interface JiraApiCommentResponse {
    id: string;
    created: string;
    updated: string;
}

export async function addComment(
    issueKey: string,
    body: string,
): Promise<JiraCommentResult> {
    try {
        const client = createJiraClient();

        const response = await client.post<JiraApiCommentResponse>(
            `/rest/api/3/issue/${issueKey}/comment`,
            { body: await resolveMentions(markdownToAdf(body)) },
        );

        return {
            key: issueKey,
            id: response.data.id,
            created: response.data.created.slice(0, 10),
        };
    } catch (error) {
        handleJiraError(error);
    }
}

/**
 * Reescribe un comentario. El texto sustituye entero al anterior, igual que un
 * campo: no se añade al final.
 *
 * Jira decide quién puede: con el permiso habitual, cada cual edita los suyos.
 * No se comprueba aquí porque el permiso depende del esquema del proyecto, y
 * su rechazo ya dice cuál falta.
 */
export async function updateComment(
    issueKey: string,
    commentId: string,
    body: string,
): Promise<JiraCommentUpdateResult> {
    try {
        const client = createJiraClient();

        const response = await client.put<JiraApiCommentResponse>(
            `/rest/api/3/issue/${issueKey}/comment/${commentId}`,
            { body: await resolveMentions(markdownToAdf(body)) },
        );

        return {
            key: issueKey,
            id: response.data.id,
            created: response.data.created.slice(0, 10),
            // Con hora: la edición suele llegar el mismo día que el comentario,
            // y solo con la fecha no se distinguía de la creación.
            updated: response.data.updated,
        };
    } catch (error) {
        handleJiraError(error);
    }
}
