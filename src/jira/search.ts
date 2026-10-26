import { adfToMarkdown } from './adf.js';
import { createJiraClient } from './client.js';
import { handleJiraError } from './error.js';
import {
    extraFieldIds,
    readExtraFields,
    resolveExtraFields,
} from './extra-fields.js';
import { normalizeName } from './names.js';

import type { JiraExtraField } from './extra-fields.js';

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
    /**
     * Documento ADF: la API v3 nunca devuelve texto plano aquí. Ausente
     * mientras nadie pida el campo.
     */
    description?: unknown;
    [key: string]: unknown;
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

/** Campo que no se pudo leer, y en qué issues de la página. */
interface FieldProblem {
    /** Motivo, tal como lo explica la lectura del primer issue afectado. */
    reason: string;
    keys: string[];
}

/**
 * Lee los campos adicionales de un issue de la búsqueda.
 *
 * Se lee cada campo por separado para que un nombre que no se pueda resolver
 * en este issue no arrastre a los demás, y el problema se acumula como aviso
 * en lugar de interrumpir la búsqueda: tumbar una página entera de resultados
 * porque un issue de otro proyecto no tiene ese campo sería peor que informar.
 */
function readSearchFields(
    extra: JiraExtraField[],
    issueKey: string,
    apiFields: Record<string, unknown>,
    problems: Map<string, FieldProblem>,
): Record<string, unknown> {
    const values: Record<string, unknown> = {};

    for (const field of extra) {
        try {
            Object.assign(
                values,
                readExtraFields([field], issueKey, apiFields),
            );
        } catch (error) {
            const reason =
                error instanceof Error ? error.message : String(error);

            const problem = problems.get(field.requested);

            if (problem) {
                problem.keys.push(issueKey);
            } else {
                problems.set(field.requested, { reason, keys: [issueKey] });
            }
        }
    }

    return values;
}

const LISTED_KEYS = 10;

/**
 * Un aviso por campo, no por issue: el mismo campo suele fallar en todos los
 * issues de la página, y repetir el motivo en veinte líneas casi idénticas
 * taparía los resultados que sí vienen.
 */
function describeProblem(
    requested: string,
    { reason, keys }: FieldProblem,
): string {
    if (keys.length === 1) {
        return reason;
    }

    const listed = keys.slice(0, LISTED_KEYS).join(', ');

    const rest =
        keys.length > LISTED_KEYS
            ? ` y ${keys.length - LISTED_KEYS} más`
            : '';

    return `No se pudo leer "${requested}" en ${keys.length} de los issues devueltos (${listed}${rest}). ${reason}`;
}

/**
 * Campos que la búsqueda ya devuelve con nombre propio. Nombrar uno de ellos
 * en `fields` pide ese campo nativo, no una copia dentro de `customFields`:
 * `fields: ["summary"]` devolvía el summary dos veces.
 */
const NATIVE_FIELD_IDS = new Set([
    'key',
    'summary',
    'status',
    'assignee',
    'description',
]);

/**
 * Identificador nativo al que apunta un campo pedido, si apunta a alguno. Se
 * resuelve contra el catálogo de la instancia, de modo que el nombre visible
 * traducido —`Descripción`— llega al mismo sitio que el identificador.
 *
 * Un nombre ambiguo no se trata como nativo: si hay varios campos llamados
 * igual, lo que se pidió no es el nativo sino uno de ellos.
 */
function nativeFieldId(field: JiraExtraField): string | undefined {
    if (field.candidates.length !== 1) {
        return undefined;
    }

    const { id } = field.candidates[0];

    return NATIVE_FIELD_IDS.has(id) ? id : undefined;
}

export async function searchIssues(
    jql: string,
    limit: number = DEFAULT_LIMIT,
    fieldNames: string[] = [],
): Promise<JiraSearchResult> {
    const requested = await resolveExtraFields(fieldNames);

    const native = new Set(
        requested.map(nativeFieldId).filter((id) => id !== undefined),
    );

    const extra = requested.filter(
        (field) => nativeFieldId(field) === undefined,
    );

    // La descripción se trae solo si se pide: es el campo que decide el tamaño
    // de la respuesta —un issue con la descripción escrita pesa más que los
    // otros veinte juntos— y censar no la necesita. Para leer un issue está
    // `jira_get_issue`.
    const wantsDescription = native.has('description');

    const page = await runJql<JiraSearchFields>(
        jql,
        [
            'summary',
            'status',
            'assignee',
            ...(wantsDescription ? ['description'] : []),
            ...extraFieldIds(extra),
        ],
        limit,
    );

    const problems = new Map<string, FieldProblem>();

    const issues: JiraIssueSummary[] = page.issues.map((issue) => ({
        key: issue.key,
        summary: issue.fields.summary,
        status: issue.fields.status.name,
        assignee: issue.fields.assignee?.displayName ?? null,
        ...(wantsDescription && {
            description: adfToMarkdown(issue.fields.description),
        }),
        ...(extra.length > 0 && {
            customFields: readSearchFields(
                extra,
                issue.key,
                issue.fields,
                problems,
            ),
        }),
    }));

    const emptyResult =
        issues.length === 0 ? await warnAboutIssueTypeName(jql) : undefined;

    const warning = [
        emptyResult,
        ...[...problems].map(([requested, problem]) =>
            describeProblem(requested, problem),
        ),
    ]
        .filter((message) => message !== undefined)
        .join('\n');

    return {
        count: issues.length,
        hasMore: page.hasMore,
        ...(warning !== '' && { warning }),
        issues,
    };
}
