import { textToAdf } from './adf.js';
import { normalizeName } from './names.js';

import type { JiraFieldSpec } from '../types/jira.js';

/**
 * Localiza un campo por su identificador o por su nombre visible, tolerando
 * diferencias de mayúsculas y acentos: el nombre depende del idioma del sitio.
 */
export function findField(
    fields: JiraFieldSpec[],
    nameOrId: string,
): JiraFieldSpec | undefined {
    const needle = normalizeName(nameOrId);

    return fields.find(
        (field) =>
            field.id === nameOrId.trim() || normalizeName(field.name) === needle,
    );
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
        return field.custom === 'textarea' ? textToAdf(value) : value;
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
        const field = findField(spec, nameOrId);

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
