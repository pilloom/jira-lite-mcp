import { adfToText } from './adf.js';
import { createJiraClient } from './client.js';
import { handleJiraError } from './error.js';
import { normalizeName } from './names.js';

import type { JiraIssueSummary, JiraSearchResult } from '../types/jira.js';

interface JiraSearchResponse<F> {
    issues: Array<{
        key: string;
        fields: F;
    }>;
    /** Ausente cuando la página devuelta es la última. */
    nextPageToken?: string;
    isLast?: boolean;
}

export interface JqlPage<F> {
    issues: Array<{ key: string; fields: F }>;
    hasMore: boolean;
}

interface JiraSearchFields {
    summary: string;
    status: {
        name: string;
    };
    assignee: {
        displayName: string;
    } | null;
    /** Documento ADF: la API v3 nunca devuelve texto plano aquí. */
    description: unknown;
}

const DEFAULT_LIMIT = 20;

/**
 * Ejecuta una consulta JQL y devuelve los issues sin interpretar. Cada
 * herramienta pide los campos que necesita y los traduce a su propio
 * contrato, de modo que comparten el acceso a la API sin compartir la forma
 * de la respuesta.
 */
export async function runJql<F>(
    jql: string,
    fields: string[],
    limit: number = DEFAULT_LIMIT,
): Promise<JqlPage<F>> {
    try {
        const client = createJiraClient();

        const response = await client.post<JiraSearchResponse<F>>(
            '/rest/api/3/search/jql',
            { jql, maxResults: limit, fields },
        );

        return {
            issues: response.data.issues,
            // Este endpoint no devuelve el total de coincidencias: pagina con
            // `nextPageToken`. Se informa de si quedan resultados en lugar de
            // inventar un total que la API ya no da.
            hasMore:
                response.data.isLast === false ||
                response.data.nextPageToken !== undefined,
        };
    } catch (error) {
        handleJiraError(error);
    }
}

const PAGE_SIZE = 100;

export interface JqlAllPages<F> {
    issues: Array<{ key: string; fields: F }>;
    /** Se alcanzó el tope sin agotar los resultados: el conjunto es parcial. */
    truncated: boolean;
}

/**
 * Recorre todas las páginas de una consulta hasta agotarla o hasta alcanzar el
 * tope indicado. Necesario para agregar sobre el conjunto completo; el tope
 * evita recorrer proyectos enormes indefinidamente y, cuando se alcanza, se
 * informa en lugar de devolver un recuento incompleto como si fuera total.
 */
export async function runJqlAll<F>(
    jql: string,
    fields: string[],
    maxIssues: number,
): Promise<JqlAllPages<F>> {
    try {
        const client = createJiraClient();

        const issues: Array<{ key: string; fields: F }> = [];

        let nextPageToken: string | undefined;

        do {
            const response = await client.post<JiraSearchResponse<F>>(
                '/rest/api/3/search/jql',
                {
                    jql,
                    maxResults: Math.min(PAGE_SIZE, maxIssues - issues.length),
                    fields,
                    ...(nextPageToken !== undefined && { nextPageToken }),
                },
            );

            issues.push(...response.data.issues);
            nextPageToken = response.data.nextPageToken;

            if (response.data.issues.length === 0) {
                break;
            }
        } while (nextPageToken !== undefined && issues.length < maxIssues);

        return {
            issues,
            truncated: nextPageToken !== undefined && issues.length >= maxIssues,
        };
    } catch (error) {
        handleJiraError(error);
    }
}

/**
 * Una búsqueda por tipo de issue que no devuelve nada es sospechosa: en JQL los
 * tipos se nombran con su identificador en inglés, aunque el sitio los muestre
 * traducidos. Escribir el nombre visible no da error, devuelve cero resultados,
 * y un cero es indistinguible de «no hay ninguno».
 *
 * El aviso solo se emite cuando la búsqueda viene vacía: en cualquier otro caso
 * sería ruido.
 */
async function warnAboutIssueTypeName(jql: string): Promise<string | undefined> {
    const match = /issuetype\s*(?:=|!=|\bin\b)\s*\(?\s*"?([^"'),\s]+)"?/i.exec(
        jql,
    );

    if (!match) {
        return undefined;
    }

    const written = match[1]!;

    if (/^\d+$/.test(written)) {
        return undefined;
    }

    try {
        const client = createJiraClient();

        const response = await client.get<
            Array<{ id: string; name: string }>
        >('/rest/api/3/issuetype');

        const displayed = response.data.some(
            (type) => normalizeName(type.name) === normalizeName(written),
        );

        if (!displayed) {
            return undefined;
        }

        return `La búsqueda no devolvió resultados. "${written}" es el nombre visible del tipo de issue, pero en JQL hay que usar su nombre canónico en inglés (Bug, Task, Story, "Sub-task", Epic) o su id; con el nombre traducido la consulta no falla, simplemente no encuentra nada.`;
    } catch {
        // El aviso es un extra: si no se puede comprobar, no se entorpece la
        // respuesta de la búsqueda con un error ajeno a ella.
        return undefined;
    }
}

export async function searchIssues(
    jql: string,
    limit: number = DEFAULT_LIMIT,
): Promise<JiraSearchResult> {
    const page = await runJql<JiraSearchFields>(
        jql,
        ['summary', 'status', 'assignee', 'description'],
        limit,
    );

    const issues: JiraIssueSummary[] = page.issues.map((issue) => ({
        key: issue.key,
        summary: issue.fields.summary,
        status: issue.fields.status.name,
        assignee: issue.fields.assignee?.displayName ?? null,
        description: adfToText(issue.fields.description),
    }));

    const warning =
        issues.length === 0 ? await warnAboutIssueTypeName(jql) : undefined;

    return {
        count: issues.length,
        hasMore: page.hasMore,
        ...(warning !== undefined && { warning }),
        issues,
    };
}
