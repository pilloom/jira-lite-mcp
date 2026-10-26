import { createJiraClient } from './client.js';
import { normalizeName } from './names.js';

/**
 * Jira no se queja de un valor que no reconoce.
 *
 * `status = Finalizada` no da error en un sitio en español donde el estado se
 * muestra como «Finalizada»: JQL solo acepta el nombre **sin traducir** —`Done`—
 * y lo que no resuelve lo trata como que no coincide con nada. Así que la
 * consulta se ejecuta, devuelve cero resultados, y con `!=` devuelve **todos**.
 * El censo sale incompleto o sobrante con la misma forma que uno correcto.
 *
 * Y el bucle lo cierra esta herramienta: la búsqueda devuelve `"status":
 * "Finalizada"`, que es el nombre traducido, y ese valor no vale en el JQL de
 * la llamada siguiente. Por eso el aviso se emite aquí y no se deja a una guía.
 */

/** Campos cuyos valores se nombran y cuyo nombre Jira traduce. */
const WATCHED_FIELDS = new Map([
    ['status', 'status'],
    ['estado', 'status'],
    ['issuetype', 'issuetype'],
    ['issue type', 'issuetype'],
    ['type', 'issuetype'],
    ['tipo', 'issuetype'],
]);

const COMPARISON =
    /"?\b(status|estado|issuetype|issue\s+type|type|tipo)\b"?\s*(?:=|!=|\bnot\s+in\b|\bin\b)\s*(\([^)]*\)|"[^"]*"|'[^']*'|[^\s()]+)/gi;

/** Un valor nombrado en el JQL, con el campo al que se compara. */
interface NamedValue {
    /** Nombre del campo tal como lo espera la API de autocompletado. */
    field: string;
    written: string;
}

function unquote(value: string): string {
    // El trim va primero: dentro de `in (a, "b c")` los valores llegan con el
    // espacio de después de la coma, y entonces la comilla ya no es el primer
    // carácter. Con la comilla pegada al nombre, un valor correcto no casaba
    // con la sugerencia de Jira y se avisaba de un acierto.
    return value.trim().replace(/^["']|["']$/g, '').trim();
}

/**
 * Lo que no se comprueba: ids —que son lo que siempre resuelve—, las palabras
 * que JQL reserva para el valor vacío, y las llamadas a función, cuyo valor no
 * está escrito en la consulta.
 */
function isNameWorthChecking(written: string): boolean {
    return (
        written !== '' &&
        !/^\d+$/.test(written) &&
        !/^(empty|null)$/i.test(written) &&
        !written.endsWith('()')
    );
}

function namedValues(jql: string): NamedValue[] {
    const values: NamedValue[] = [];

    for (const match of jql.matchAll(COMPARISON)) {
        const field = WATCHED_FIELDS.get(normalizeName(unquote(match[1])));

        if (field === undefined) {
            continue;
        }

        const written = match[2];

        const listed = written.startsWith('(')
            ? written.slice(1, -1).split(',')
            : [written];

        for (const item of listed) {
            const name = unquote(item);

            if (isNameWorthChecking(name)) {
                values.push({ field, written: name });
            }
        }
    }

    return values;
}

/**
 * Pregunta a Jira si un valor resuelve, en lugar de deducirlo de un catálogo:
 * el autocompletado de JQL responde exactamente a eso, y es el mismo motor que
 * interpreta la consulta. Deducirlo arriesga el peor resultado para un aviso,
 * que es el falso positivo.
 *
 * Las sugerencias son por prefijo, así que hace falta la coincidencia exacta:
 * `status = Do` no resuelve aunque sugiera `Done`.
 */
async function resolvesInJql(
    { field, written }: NamedValue,
): Promise<boolean> {
    const client = createJiraClient();

    const response = await client.get<{
        results: Array<{ value: string }>;
    }>('/rest/api/3/jql/autocompletedata/suggestions', {
        params: { fieldName: field, fieldValue: written },
    });

    return response.data.results.some(
        (result) =>
            normalizeName(unquote(result.value)) === normalizeName(written),
    );
}

/**
 * Nombre visible normalizado → nombre que acepta JQL, y el id cuando
 * identifica. El id se omite si varios campos comparten el nombre visible:
 * entonces no se sabe cuál de ellos se quería, y sugerir uno al azar cambia un
 * fallo silencioso por otro.
 */
type CanonicalNames = Map<string, { canonical: string; id?: string }>;

/**
 * Añade un nombre al mapa. Un nombre repetido conserva el canónico —que es el
 * mismo— y pierde el id.
 */
function addName(
    names: CanonicalNames,
    visible: string,
    canonical: string,
    id: string,
): void {
    const key = normalizeName(visible);
    const known = names.get(key);

    names.set(key, {
        canonical,
        ...(known === undefined && { id }),
    });
}

/**
 * Los estados llegan traducidos por dos endpoints distintos: `/status` da el
 * nombre visible y `/statuses/search` el que JQL acepta. Se cruzan por id, que
 * es lo único común a los dos.
 */
async function statusNames(): Promise<CanonicalNames> {
    const client = createJiraClient();

    const [visible, canonical] = await Promise.all([
        client.get<Array<{ id: string; name: string }>>('/rest/api/3/status'),
        client.get<{ values: Array<{ id: string; name: string }> }>(
            '/rest/api/3/statuses/search',
            { params: { maxResults: 200 } },
        ),
    ]);

    const byId = new Map(
        canonical.data.values.map((status) => [status.id, status.name]),
    );

    const names: CanonicalNames = new Map();

    for (const status of visible.data) {
        const name = byId.get(status.id);

        if (name !== undefined) {
            addName(names, status.name, name, status.id);
        }
    }

    return names;
}

/** Los tipos de issue sí traen el nombre sin traducir en la misma respuesta. */
async function issueTypeNames(): Promise<CanonicalNames> {
    const client = createJiraClient();

    const response = await client.get<
        Array<{ id: string; name: string; untranslatedName?: string }>
    >('/rest/api/3/issuetype');

    const names: CanonicalNames = new Map();

    for (const type of response.data) {
        // Los tipos de issue se repiten por proyecto —hay un «Tarea» por cada
        // uno, con su propio id—, así que aquí el id casi nunca identifica.
        if (type.untranslatedName !== undefined) {
            addName(names, type.name, type.untranslatedName, type.id);
        }
    }

    return names;
}

const FIELD_LABELS = new Map([
    ['status', 'estado'],
    ['issuetype', 'tipo de issue'],
]);

function describe(
    { field, written }: NamedValue,
    canonical: { canonical: string; id?: string } | undefined,
): string {
    const label = FIELD_LABELS.get(field) ?? field;

    const consequence = `Jira no da error con un valor que no resuelve, lo trata como que no coincide con nada: con "=" la consulta devuelve cero resultados y con "!=" los devuelve todos, así que el resultado de arriba no responde a lo que se preguntó.`;

    if (canonical === undefined) {
        return `En JQL no resuelve ningún ${label} llamado "${written}". ${consequence}`;
    }

    const byId =
        canonical.id === undefined ? '' : ` o su id ${canonical.id}`;

    return `"${written}" es el nombre visible del ${label} en este sitio, pero JQL solo acepta el nombre sin traducir: hay que escribir ${canonical.canonical} —entre comillas si lleva espacios—${byId}. ${consequence}`;
}

/**
 * Avisa de los valores del JQL que Jira no resuelve, con el nombre que sí
 * acepta cuando se puede averiguar.
 *
 * Se emite haya resultados o no: con `!=` el fallo produce filas de más, no de
 * menos, y ahí una respuesta llena es tan engañosa como una vacía.
 *
 * El aviso es un extra. Si no se puede comprobar, la búsqueda responde sin él
 * en lugar de fallar por un error ajeno a ella.
 */
export async function warnAboutJqlNames(
    jql: string,
): Promise<string | undefined> {
    const values = namedValues(jql);

    if (values.length === 0) {
        return undefined;
    }

    try {
        const checked = await Promise.all(
            values.map(async (value) => ({
                value,
                resolves: await resolvesInJql(value),
            })),
        );

        const unresolved = checked
            .filter(({ resolves }) => !resolves)
            .map(({ value }) => value);

        if (unresolved.length === 0) {
            return undefined;
        }

        const names = new Map<string, CanonicalNames>([
            ...(unresolved.some(({ field }) => field === 'status')
                ? [['status', await statusNames()] as const]
                : []),
            ...(unresolved.some(({ field }) => field === 'issuetype')
                ? [['issuetype', await issueTypeNames()] as const]
                : []),
        ]);

        return unresolved
            .map((value) =>
                describe(
                    value,
                    names.get(value.field)?.get(normalizeName(value.written)),
                ),
            )
            .join('\n');
    } catch {
        return undefined;
    }
}
