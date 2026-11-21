import { createJiraClient } from './client.js';
import { handleJiraError } from './error.js';
import { buildCustomFields, findField } from './fields.js';
import { markdownToAdf } from './markdown.js';
import { resolveMentions } from './mentions.js';
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
        fields.description = markdownToAdf(input.description);
    }

    if (assigneeId !== undefined) {
        assertEditable('assignee', '"Persona asignada"', spec, input.issueKey);
        fields.assignee = { id: assigneeId };
    }

    // Como al crear: Jira acepta la estimación aunque `timetracking` no figure
    // en la pantalla de edición, así que no se comprueba contra el esquema.
    // Las dos van en el mismo objeto: la que no se indica queda como estaba.
    if (
        input.originalEstimate !== undefined ||
        input.remainingEstimate !== undefined
    ) {
        fields.timetracking = {
            ...(input.originalEstimate !== undefined && {
                originalEstimate: input.originalEstimate,
            }),
            ...(input.remainingEstimate !== undefined && {
                remainingEstimate: input.remainingEstimate,
            }),
        };
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

/**
 * Relee la estimación tras escribirla. Jira no recalcula el restante al cambiar
 * la estimación original, y la respuesta de la edición no trae nada: sin esto,
 * un restante viejo quedaba en el issue sin que nada lo señalara.
 */
async function readTimetracking(
    input: JiraUpdateIssueInput,
): Promise<Pick<JiraUpdatedIssue, 'timetracking' | 'warning'>> {
    const response = await createJiraClient().get<{
        fields: {
            timetracking?: {
                originalEstimate?: string;
                originalEstimateSeconds?: number;
                remainingEstimate?: string;
                remainingEstimateSeconds?: number;
            };
        };
    }>(`/rest/api/3/issue/${input.issueKey}`, {
        params: { fields: 'timetracking' },
    });

    const read = response.data.fields.timetracking ?? {};

    const timetracking = {
        originalEstimate: read.originalEstimate ?? null,
        remainingEstimate: read.remainingEstimate ?? null,
    };

    // Solo se avisa si se cambió la estimación sin decir nada del restante y
    // los dos no coinciden. Con horas registradas puede ser lo correcto, así
    // que no se corrige: se dice, y lo decide quien llama.
    const stale =
        input.originalEstimate !== undefined &&
        input.remainingEstimate === undefined &&
        read.remainingEstimateSeconds !== undefined &&
        read.remainingEstimateSeconds !== read.originalEstimateSeconds;

    return {
        timetracking,
        ...(stale && {
            warning: `Jira no recalcula el tiempo restante al cambiar la estimación: sigue en ${timetracking.remainingEstimate}. Si debe cambiar, indica remainingEstimate.`,
        }),
    };
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

        const fields = await resolveMentions(
            buildFields(input, spec, assigneeId),
        );

        const client = createJiraClient();

        if (Object.keys(fields).length > 0) {
            await client.put(`/rest/api/3/issue/${input.issueKey}`, { fields });
        }

        const estimate =
            'timetracking' in fields ? await readTimetracking(input) : {};

        const watchers =
            input.watchers !== undefined && input.watchers.length > 0
                ? await addWatchers(input.issueKey, input.watchers)
                : undefined;

        return {
            key: input.issueKey,
            updated: Object.keys(fields),
            ...estimate,
            ...(watchers !== undefined && { watchers }),
        };
    } catch (error) {
        handleJiraError(error);
    }
}
