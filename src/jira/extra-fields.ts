import { findFields, readFieldValue } from './fields.js';
import { getAllFields, refreshAllFields } from './meta.js';

import type { JiraFieldSpec } from '../types/jira.js';

/**
 * Campos adicionales que se piden por su nombre al leer un issue.
 *
 * Al leer no hay pantalla que acote los campos disponibles, así que se
 * resuelven contra el catálogo entero de la instancia. Y ahí el nombre visible
 * no identifica: es habitual tener el mismo nombre repetido, un campo por
 * proyecto. Por eso se guardan todos los candidatos y la elección se deja para
 * cuando llegue la respuesta del issue, que ya dice cuáles le aplican.
 */
export interface JiraExtraField {
    /** Nombre tal como se pidió, que es como aparece en los errores. */
    requested: string;
    /** Nombre canónico en Jira, con el que se devuelve el valor. */
    name: string;
    candidates: JiraFieldSpec[];
}

export async function resolveExtraFields(
    names: string[],
): Promise<JiraExtraField[]> {
    if (names.length === 0) {
        return [];
    }

    let catalog = await getAllFields();

    // Un campo creado con la sesión ya abierta no está en el catálogo que se
    // cacheó al arrancar. Antes de declararlo inexistente se vuelve a pedir:
    // el error contrario —afirmar que no existe algo que sí existe— lleva a
    // repetir una escritura que había funcionado.
    if (names.some((name) => findFields(catalog, name).length === 0)) {
        catalog = await refreshAllFields();
    }

    return names.map((name) => {
        const candidates = findFields(catalog, name);

        if (candidates.length === 0) {
            throw new Error(
                `El campo "${name}" no existe en esta instancia de Jira.`,
            );
        }

        return { requested: name, name: candidates[0].name, candidates };
    });
}

/** Identificadores a pedir a la API, incluidos los de un nombre ambiguo. */
export function extraFieldIds(fields: JiraExtraField[]): string[] {
    return fields.flatMap((field) =>
        field.candidates.map((candidate) => candidate.id),
    );
}

function listIds(candidates: JiraFieldSpec[]): string {
    return candidates.map((candidate) => candidate.id).join(', ');
}

/**
 * Extrae el valor de un campo de la respuesta del issue.
 *
 * Con varios candidatos, la propia respuesta desambigua: Jira solo devuelve
 * los campos que aplican al proyecto del issue. Si aun así queda más de uno
 * —o ninguno—, se rechaza en vez de devolver `null`: un ticket con criterios
 * de aceptación leído como vacío no levanta ninguna sospecha.
 */
function readValue(
    field: JiraExtraField,
    issueKey: string,
    apiFields: Record<string, unknown>,
): unknown {
    if (field.candidates.length === 1) {
        return readFieldValue(apiFields[field.candidates[0].id]);
    }

    const present = field.candidates.filter((candidate) =>
        Object.hasOwn(apiFields, candidate.id),
    );

    if (present.length === 1) {
        return readFieldValue(apiFields[present[0].id]);
    }

    if (present.length > 1) {
        throw new Error(
            `Varios campos se llaman "${field.requested}" en ${issueKey}: ${listIds(present)}. Indicar cuál por su identificador.`,
        );
    }

    throw new Error(
        `Varios campos de esta instancia se llaman "${field.requested}" (${listIds(field.candidates)}) y ninguno aplica a ${issueKey}. Indicar por su identificador el que corresponde a este proyecto.`,
    );
}

export function readExtraFields(
    fields: JiraExtraField[],
    issueKey: string,
    apiFields: Record<string, unknown>,
): Record<string, unknown> {
    const values: Record<string, unknown> = {};

    for (const field of fields) {
        values[field.name] = readValue(field, issueKey, apiFields);
    }

    return values;
}
