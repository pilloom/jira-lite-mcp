import { textToAdf } from './adf.js';
import { createJiraClient } from './client.js';
import { handleJiraError } from './error.js';
import { normalizeName } from './names.js';

import type { JiraTransition, JiraTransitionResult } from '../types/jira.js';

interface JiraApiTransition {
    id: string;
    name: string;
    to: {
        name: string;
    };
}

interface JiraApiTransitionsResponse {
    transitions: JiraApiTransition[];
}

/**
 * Localiza una transición por su id, por su nombre o por el nombre del estado
 * al que lleva. Los tres varían con el workflow y con el idioma del sitio, así
 * que se resuelven contra el issue en lugar de asumir identificadores fijos.
 */
function findTransition(
    transitions: JiraApiTransition[],
    wanted: string,
): JiraApiTransition | undefined {
    const needle = normalizeName(wanted);

    return transitions.find(
        (transition) =>
            transition.id === wanted.trim() ||
            normalizeName(transition.name) === needle ||
            normalizeName(transition.to.name) === needle,
    );
}

export async function getTransitions(
    issueKey: string,
): Promise<JiraTransition[]> {
    try {
        const client = createJiraClient();

        const response = await client.get<JiraApiTransitionsResponse>(
            `/rest/api/3/issue/${issueKey}/transitions`,
        );

        return response.data.transitions.map((transition) => ({
            id: transition.id,
            name: transition.name,
            to: transition.to.name,
        }));
    } catch (error) {
        handleJiraError(error);
    }
}

export async function transitionIssue(
    issueKey: string,
    to: string,
    comment?: string,
): Promise<JiraTransitionResult> {
    try {
        const client = createJiraClient();

        const available = await client.get<JiraApiTransitionsResponse>(
            `/rest/api/3/issue/${issueKey}/transitions`,
        );

        const transition = findTransition(available.data.transitions, to);

        if (!transition) {
            // El error enumera las opciones válidas para que quien llama pueda
            // corregir sin tener que consultar el workflow por separado.
            const options = available.data.transitions
                .map((candidate) => `"${candidate.name}" → ${candidate.to.name}`)
                .join(', ');

            throw new Error(
                `La transición "${to}" no está disponible en ${issueKey}. Transiciones posibles: ${options || 'ninguna'}`,
            );
        }

        await client.post(`/rest/api/3/issue/${issueKey}/transitions`, {
            transition: { id: transition.id },
        });

        // El comentario se publica por separado a propósito. Adjuntarlo a la
        // transición solo funciona si el workflow define una pantalla que
        // incluya el campo: cuando no la hay, Jira responde 204 y lo descarta
        // sin avisar, de modo que el comentario se perdería en silencio.
        if (comment !== undefined) {
            await client.post(`/rest/api/3/issue/${issueKey}/comment`, {
                body: textToAdf(comment),
            });
        }

        return {
            key: issueKey,
            status: transition.to.name,
            transition: transition.name,
        };
    } catch (error) {
        handleJiraError(error);
    }
}
