import { createJiraClient } from './client.js';
import { handleJiraError } from './error.js';

import type { JiraUser } from '../types/jira.js';

interface JiraApiUserResponse {
    accountId: string;
    displayName: string;
    emailAddress?: string;
}

/** Un accountId de Jira Cloud no contiene arroba ni espacios. */
function looksLikeAccountId(value: string): boolean {
    return !value.includes('@') && !value.includes(' ');
}

/**
 * Traduce un correo o un nombre visible al identificador de cuenta que exige
 * la API. Un identificador se devuelve sin consultar nada.
 *
 * Cuando la búsqueda encuentra varias personas se rechaza en lugar de elegir:
 * asignar el issue a quien no toca es peor que pedir que se concrete.
 */
export async function resolveAccountId(
    emailOrNameOrId: string,
): Promise<string> {
    const value = emailOrNameOrId.trim();

    if (looksLikeAccountId(value)) {
        return value;
    }

    try {
        const client = createJiraClient();

        const response = await client.get<JiraApiUserResponse[]>(
            '/rest/api/3/user/search',
            { params: { query: value } },
        );

        const matches = response.data;

        if (matches.length === 0) {
            throw new Error(
                `No se encontró ningún usuario de Jira para "${value}".`,
            );
        }

        if (matches.length > 1) {
            const names = matches
                .map((user) => `${user.displayName} (${user.accountId})`)
                .join(', ');

            throw new Error(
                `"${value}" corresponde a varios usuarios de Jira. Indicar el accountId de uno: ${names}`,
            );
        }

        return matches[0]!.accountId;
    } catch (error) {
        handleJiraError(error);
    }
}

export async function getCurrentUser(): Promise<JiraUser> {
    try {
        const client = createJiraClient();

        const response = await client.get<JiraApiUserResponse>(
            '/rest/api/3/myself',
        );

        return {
            accountId: response.data.accountId,
            displayName: response.data.displayName,
            email: response.data.emailAddress ?? null,
        };
    } catch (error) {
        handleJiraError(error);
    }
}
