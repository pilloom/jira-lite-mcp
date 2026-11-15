import { createJiraClient } from './client.js';
import { handleJiraError } from './error.js';

import type { JiraUser } from '../types/jira.js';

interface JiraApiUserResponse {
    accountId: string;
    displayName: string;
    emailAddress?: string;
}

/**
 * Forma de un accountId de Jira Cloud: 24 hexadecimales en las cuentas
 * antiguas, o un prefijo y un UUID separados por dos puntos en las nuevas
 * —`557058:f58131cb-…`—.
 *
 * Antes bastaba con no tener arroba ni espacios, y eso convertía un nombre de
 * una sola palabra —«Pedro»— en un identificador que no existe: la asignación
 * fallaba con un error de Jira que no decía por qué, y una mención salía rota.
 */
const ACCOUNT_ID = /^(?:[0-9a-f]{24}|[\w-]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Sin arroba ni espacios podría ser un identificador de un formato que no se conoce. */
function couldBeAccountId(value: string): boolean {
    return !value.includes('@') && !/\s/.test(value);
}

export interface JiraResolvedUser {
    accountId: string;
    displayName: string;
}

async function getUserById(accountId: string): Promise<JiraResolvedUser | null> {
    const client = createJiraClient();

    const response = await client.get<JiraApiUserResponse>('/rest/api/3/user', {
        params: { accountId },
        // Un identificador que no existe responde 404: aquí es «no es un
        // accountId», no un fallo que interrumpa la búsqueda.
        validateStatus: (status) => status === 200 || status === 404,
    });

    return response.status === 200
        ? {
              accountId: response.data.accountId,
              displayName: response.data.displayName,
          }
        : null;
}

/**
 * Traduce un correo, un nombre visible o un accountId a la persona de Jira
 * que designa, con su nombre visible.
 *
 * Cuando la búsqueda encuentra varias personas se rechaza en lugar de elegir:
 * asignar o mencionar a quien no toca es peor que pedir que se concrete.
 */
export async function resolveUser(
    emailOrNameOrId: string,
): Promise<JiraResolvedUser> {
    const value = emailOrNameOrId.trim();

    try {
        if (ACCOUNT_ID.test(value)) {
            const user = await getUserById(value);

            if (!user) {
                throw new Error(
                    `No existe ningún usuario de Jira con el accountId "${value}".`,
                );
            }

            return user;
        }

        const client = createJiraClient();

        const response = await client.get<JiraApiUserResponse[]>(
            '/rest/api/3/user/search',
            { params: { query: value } },
        );

        // La búsqueda es difusa: un nombre completo trae también a quien
        // comparte un apellido. Si una sola coincidencia es exacta —nombre o
        // correo—, es la que se pidió; las demás no hacen ambiguo el valor.
        const wanted = value.toLocaleLowerCase();

        const exact = response.data.filter(
            (user) =>
                user.displayName.toLocaleLowerCase() === wanted ||
                user.emailAddress?.toLocaleLowerCase() === wanted,
        );

        const matches = exact.length === 1 ? exact : response.data;

        if (matches.length === 0) {
            // La búsqueda mira nombres y correos, no identificadores: uno con
            // un formato que no se reconoce se comprueba antes de rendirse.
            const user = couldBeAccountId(value)
                ? await getUserById(value)
                : null;

            if (user) {
                return user;
            }

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

        return {
            accountId: matches[0]!.accountId,
            displayName: matches[0]!.displayName,
        };
    } catch (error) {
        handleJiraError(error);
    }
}

/**
 * Traduce un correo o un nombre visible al identificador de cuenta que exige
 * la API. Un identificador reconocible se devuelve sin consultar nada.
 */
export async function resolveAccountId(
    emailOrNameOrId: string,
): Promise<string> {
    const value = emailOrNameOrId.trim();

    if (ACCOUNT_ID.test(value)) {
        return value;
    }

    return (await resolveUser(value)).accountId;
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
