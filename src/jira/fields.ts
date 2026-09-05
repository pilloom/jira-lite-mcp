import { adfToMarkdown, isAdfDocument } from './adf.js';
import { markdownToAdf } from './markdown.js';
import { normalizeName } from './names.js';

import type { JiraFieldSpec } from '../types/jira.js';

/**
 * Traduce el valor de un campo a algo legible sin perder información.
 *
 * La API representa cada tipo de campo a su manera: texto rico como documento,
 * usuarios y equipos como objetos, listas desplegables como `{id, value}`. Ante
 * una forma que no reconoce, **devuelve el valor tal cual**: una cadena vacía
 * sería indistinguible de un campo sin rellenar, que es la peor respuesta
 * posible porque nadie sospecha de ella.
 */
export function readFieldValue(value: unknown): unknown {
    if (value === null || value === undefined) {
        return null;
    }

    if (typeof value !== 'object') {
        return value;
    }

    if (isAdfDocument(value)) {
        return adfToMarkdown(value);
    }

    if (Array.isArray(value)) {
        return value.map(readFieldValue);
    }

    const object = value as Record<string, unknown>;

    // Los objetos de Jira nombran su etiqueta visible de tres formas distintas
    // según el tipo de campo. El identificador se conserva cuando existe:
    // es lo que hace falta para volver a escribir ese mismo valor.
    const label =
        object.displayName ?? object.name ?? object.value;

    if (typeof label === 'string') {
        return typeof object.id === 'string'
            ? { id: object.id, name: label }
            : label;
    }

    return value;
}

/**
 * Localiza los campos que responden a un identificador o a un nombre visible,
 * tolerando diferencias de mayúsculas y acentos: el nombre depende del idioma
 * del sitio.
 *
 * Devuelve una lista porque el nombre no identifica: una instancia puede tener
 * varios campos llamados igual, uno por proyecto. El identificador sí es único,
 * de modo que cuando coincide se devuelve solo ese.
 */
export function findFields(
    fields: JiraFieldSpec[],
    nameOrId: string,
): JiraFieldSpec[] {
    const wanted = nameOrId.trim();

    const byId = fields.find((field) => field.id === wanted);

    if (byId) {
        return [byId];
    }

    const needle = normalizeName(wanted);

    return fields.filter((field) => normalizeName(field.name) === needle);
}

/**
 * Primera coincidencia, para quien busca un campo del que ya conoce el
 * identificador y por tanto no puede toparse con un nombre ambiguo.
 */
export function findField(
    fields: JiraFieldSpec[],
    nameOrId: string,
): JiraFieldSpec | undefined {
    return findFields(fields, nameOrId)[0];
}

/**
 * Da al valor la forma que espera la API según el tipo declarado del campo.
 * Un valor que ya viene como objeto se respeta tal cual: permite cubrir campos
 * que este serializador todavía no contempla sin bloquear al llamante.
 */
export function serializeValue(field: JiraFieldSpec, value: unknown): unknown {
    if (value !== null && typeof value === 'object') {
        return value;
    }

    if (field.type === 'string' && typeof value === 'string') {
        return field.custom === 'textarea' ? markdownToAdf(value) : value;
    }

    if (typeof value !== 'string') {
        return value;
    }

    switch (field.type) {
        case 'priority':
        case 'component':
        case 'version':
        case 'resolution':
            return { name: value };
        case 'issuelink':
            return { key: value };
        case 'user':
            return { id: value };
        case 'option':
            return { value };
        default:
            return value;
    }
}

/**
 * Resuelve un conjunto de campos indicados por nombre o identificador contra
 * los que admite el issue, y los deja serializados y listos para la API.
 */
export function buildCustomFields(
    customFields: Record<string, unknown>,
    spec: JiraFieldSpec[],
    context: string,
): Record<string, unknown> {
    const fields: Record<string, unknown> = {};

    for (const [nameOrId, value] of Object.entries(customFields)) {
        const candidates = findFields(spec, nameOrId);

        if (candidates.length > 1) {
            const ids = candidates.map((candidate) => candidate.id).join(', ');

            throw new Error(
                `Varios campos se llaman "${nameOrId}" ${context}: ${ids}. Indicar cuál por su identificador.`,
            );
        }

        const field = candidates[0];

        if (!field) {
            const available = spec
                .filter((candidate) => candidate.id.startsWith('customfield_'))
                .map((candidate) => `"${candidate.name}"`)
                .join(', ');

            throw new Error(
                `El campo "${nameOrId}" no existe ${context}. Campos personalizados disponibles: ${available || 'ninguno'}`,
            );
        }

        fields[field.id] = serializeValue(field, value);
    }

    return fields;
}
