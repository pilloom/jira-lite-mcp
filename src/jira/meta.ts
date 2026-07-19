import type { AxiosInstance } from 'axios';

import { createJiraClient } from './client.js';
import { handleJiraError } from './error.js';

import type {
    JiraAllowedValue,
    JiraFieldSpec,
    JiraIssueFieldsResult,
    JiraIssueType,
    JiraIssueTypesResult,
} from '../types/jira.js';

interface JiraApiIssueType {
    id: string;
    name: string;
    subtask: boolean;
}

interface JiraApiIssueTypesResponse {
    total: number;
    issueTypes: JiraApiIssueType[];
}

interface JiraApiAllowedValue {
    id?: string;
    name?: string;
    value?: string;
}

interface JiraApiField {
    fieldId?: string;
    key?: string;
    name: string;
    required: boolean;
    schema?: {
        type: string;
        items?: string;
        custom?: string;
    };
    allowedValues?: JiraApiAllowedValue[];
}

interface JiraApiFieldsResponse {
    total: number;
    fields: JiraApiField[];
}

const PAGE_SIZE = 100;

async function fetchIssueTypes(
    client: AxiosInstance,
    projectKey: string,
): Promise<JiraApiIssueType[]> {
    const issueTypes: JiraApiIssueType[] = [];

    let startAt = 0;

    for (;;) {
        const response = await client.get<JiraApiIssueTypesResponse>(
            `/rest/api/3/issue/createmeta/${projectKey}/issuetypes`,
            { params: { startAt, maxResults: PAGE_SIZE } },
        );

        const page = response.data.issueTypes;

        if (page.length === 0) {
            break;
        }

        issueTypes.push(...page);
        startAt += page.length;

        if (startAt >= response.data.total) {
            break;
        }
    }

    return issueTypes;
}

async function fetchFields(
    client: AxiosInstance,
    projectKey: string,
    issueTypeId: string,
): Promise<JiraApiField[]> {
    const fields: JiraApiField[] = [];

    let startAt = 0;

    for (;;) {
        const response = await client.get<JiraApiFieldsResponse>(
            `/rest/api/3/issue/createmeta/${projectKey}/issuetypes/${issueTypeId}`,
            { params: { startAt, maxResults: PAGE_SIZE } },
        );

        const page = response.data.fields;

        if (page.length === 0) {
            break;
        }

        fields.push(...page);
        startAt += page.length;

        if (startAt >= response.data.total) {
            break;
        }
    }

    return fields;
}

/**
 * Localiza un tipo de issue por su id o por su nombre, sin distinguir mayúsculas.
 * El nombre del tipo depende del idioma y de la configuración del sitio
 * (por ejemplo "Bug" o "Error"), por eso se resuelve contra la instancia.
 */
function findIssueType(
    issueTypes: JiraApiIssueType[],
    wanted: string,
): JiraApiIssueType | undefined {
    const needle = wanted.trim().toLowerCase();

    return issueTypes.find(
        (issueType) =>
            issueType.id === wanted.trim() ||
            issueType.name.toLowerCase() === needle,
    );
}

function toAllowedValue(value: JiraApiAllowedValue): JiraAllowedValue {
    return {
        id: value.id ?? null,
        name: value.name ?? value.value ?? value.id ?? '',
    };
}

/**
 * Reduce la definición de un campo a lo necesario para construir un issue:
 * identificador, nombre legible, obligatoriedad, tipo y valores admitidos.
 * Se descarta el resto (operations, autoCompleteUrl, scope, iconos, urls).
 */
function toFieldSpec(field: JiraApiField): JiraFieldSpec {
    const type = field.schema?.items
        ? `array<${field.schema.items}>`
        : field.schema?.type ?? 'unknown';

    const spec: JiraFieldSpec = {
        id: field.fieldId ?? field.key ?? '',
        name: field.name,
        required: field.required,
        type,
    };

    // Del identificador completo del plugin solo interesa la variante final:
    // "com.atlassian.jira.plugin.system.customfieldtypes:textarea" -> "textarea".
    const custom = field.schema?.custom?.split(':').pop();

    if (custom) {
        spec.custom = custom;
    }

    if (field.allowedValues && field.allowedValues.length > 0) {
        spec.allowedValues = field.allowedValues.map(toAllowedValue);
    }

    return spec;
}

let fieldCatalog: JiraFieldSpec[] | null = null;

/**
 * Catálogo de todos los campos de la instancia, para resolver por nombre los
 * que no aparecen en las pantallas de creación o edición —al leer un issue no
 * hay un contexto que acote los campos disponibles—.
 *
 * Se cachea por proceso: la definición de los campos no cambia durante una
 * sesión y la consulta devuelve el catálogo entero.
 */
export async function getAllFields(): Promise<JiraFieldSpec[]> {
    if (fieldCatalog !== null) {
        return fieldCatalog;
    }

    try {
        const client = createJiraClient();

        const response = await client.get<
            Array<Omit<JiraApiField, 'required'> & { id: string }>
        >('/rest/api/3/field');

        fieldCatalog = response.data.map((field) =>
            toFieldSpec({ ...field, fieldId: field.id, required: false }),
        );

        return fieldCatalog;
    } catch (error) {
        handleJiraError(error);
    }
}

/**
 * Campos que el issue admite al editarse. A diferencia de la pantalla de
 * creación, la API los devuelve indexados por identificador en lugar de como
 * lista, así que se normalizan al mismo contrato.
 */
export async function getEditableFields(
    issueKey: string,
): Promise<JiraFieldSpec[]> {
    try {
        const client = createJiraClient();

        const response = await client.get<{
            fields: Record<string, Omit<JiraApiField, 'fieldId'>>;
        }>(`/rest/api/3/issue/${issueKey}/editmeta`);

        return Object.entries(response.data.fields).map(([id, field]) =>
            toFieldSpec({ ...field, fieldId: id }),
        );
    } catch (error) {
        handleJiraError(error);
    }
}

export async function getIssueTypes(
    projectKey: string,
): Promise<JiraIssueTypesResult> {
    try {
        const client = createJiraClient();

        const issueTypes = await fetchIssueTypes(client, projectKey);

        const result: JiraIssueType[] = issueTypes.map((issueType) => ({
            id: issueType.id,
            name: issueType.name,
            subtask: issueType.subtask,
        }));

        return {
            project: projectKey,
            issueTypes: result,
        };
    } catch (error) {
        handleJiraError(error);
    }
}

export async function getIssueTypeFields(
    projectKey: string,
    issueTypeNameOrId: string,
): Promise<JiraIssueFieldsResult> {
    try {
        const client = createJiraClient();

        const issueTypes = await fetchIssueTypes(client, projectKey);

        const issueType = findIssueType(issueTypes, issueTypeNameOrId);

        if (!issueType) {
            const available = issueTypes
                .map((candidate) => candidate.name)
                .join(', ');

            throw new Error(
                `Tipo de issue "${issueTypeNameOrId}" no encontrado en el proyecto ${projectKey}. Tipos disponibles: ${available}`,
            );
        }

        const fields = await fetchFields(client, projectKey, issueType.id);

        return {
            project: projectKey,
            issueType: issueType.name,
            fields: fields.map(toFieldSpec),
        };
    } catch (error) {
        handleJiraError(error);
    }
}
