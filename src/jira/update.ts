import { textToAdf } from './adf.js';
import { createJiraClient } from './client.js';
import { handleJiraError } from './error.js';
import { buildCustomFields, findField } from './fields.js';
import { getEditableFields } from './meta.js';
import { resolveAccountId } from './users.js';
import { addWatchers } from './watchers.js';

import type {
    JiraFieldSpec,
    JiraUpdateIssueInput,
    JiraUpdatedIssue,
} from '../types/jira.js';

/**
 * Rechaza los campos que el issue no admite editar. Jira ignora en silencio lo
 * que no está en la pantalla de edición, de modo que sin esta comprobación una
 * actualización podría darse por buena sin haber cambiado nada.
 */
function assertEditable(
    fieldId: string,
    label: string,
    spec: JiraFieldSpec[],
    issueKey: string,
): void {
    if (findField(spec, fieldId)) {
        return;
    }

    const available = spec.map((field) => `"${field.name}"`).join(', ');

    throw new Error(
        `El campo ${label} no se puede editar en ${issueKey}. Campos editables: ${available || 'ninguno'}`,
    );
}

function buildFields(
    input: JiraUpdateIssueInput,
    spec: JiraFieldSpec[],
    assigneeId?: string,
): Record<string, unknown> {
    const fields: Record<string, unknown> = {};

    if (input.summary !== undefined) {
        assertEditable('summary', '"Resumen"', spec, input.issueKey);
        fields.summary = input.summary;
    }

    if (input.description !== undefined) {
        assertEditable('description', '"Descripción"', spec, input.issueKey);
        fields.description = textToAdf(input.description);
    }

    if (assigneeId !== undefined) {
        assertEditable('assignee', '"Persona asignada"', spec, input.issueKey);
        fields.assignee = { id: assigneeId };
    }

    // Como al crear: Jira acepta la estimación aunque `timetracking` no figure
    // en la pantalla de edición, así que no se comprueba contra el esquema.
    if (input.originalEstimate !== undefined) {
        fields.timetracking = { originalEstimate: input.originalEstimate };
    }

    if (input.priority !== undefined) {
        assertEditable('priority', '"Prioridad"', spec, input.issueKey);
        fields.priority = { name: input.priority };
    }

    if (input.labels !== undefined) {
        assertEditable('labels', '"Etiquetas"', spec, input.issueKey);
        fields.labels = input.labels;
    }

    Object.assign(
        fields,
        buildCustomFields(
            input.customFields ?? {},
            spec,
            `al editar ${input.issueKey}`,
        ),
    );

    if (Object.keys(fields).length === 0 && input.watchers === undefined) {
        throw new Error(
            `No se indicó ningún campo que actualizar en ${input.issueKey}`,
        );
    }

    return fields;
}

export async function updateIssue(
    input: JiraUpdateIssueInput,
): Promise<JiraUpdatedIssue> {
    try {
        const spec = await getEditableFields(input.issueKey);

        const assigneeId =
            input.assignee !== undefined
                ? await resolveAccountId(input.assignee)
                : undefined;

        const fields = buildFields(input, spec, assigneeId);

        const client = createJiraClient();

        if (Object.keys(fields).length > 0) {
            await client.put(`/rest/api/3/issue/${input.issueKey}`, { fields });
        }

        const watchers =
            input.watchers !== undefined && input.watchers.length > 0
                ? await addWatchers(input.issueKey, input.watchers)
                : undefined;

        return {
            key: input.issueKey,
            updated: Object.keys(fields),
            ...(watchers !== undefined && { watchers }),
        };
    } catch (error) {
        handleJiraError(error);
    }
}
