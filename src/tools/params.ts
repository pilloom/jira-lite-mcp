import { z } from 'zod';

/**
 * Nombres que otros servidores de Jira usan para lo mismo. Llegan en las
 * llamadas porque quien las escribe arrastra la costumbre de aquellos, y
 * traducirlos en el mensaje de error ahorra adivinar el nombre bueno.
 *
 * No se aceptan como alias a propósito: un parámetro con otro nombre se
 * rechaza —ver el aviso de abajo— en lugar de aplicarse, para que el payload
 * que funciona sea siempre el mismo.
 */
const EQUIVALENTS: Record<string, string> = {
    additional_fields: 'customFields',
    assignee_account_id: 'assignee',
    assigneeAccountId: 'assignee',
    custom_fields: 'customFields',
    dry_run: 'dryRun',
    issue_key: 'issueKey',
    issue_type: 'issueType',
    issueIdOrKey: 'issueKey',
    issuetype: 'issueType',
    original_estimate: 'originalEstimate',
    parent_key: 'parent',
    parentKey: 'parent',
    priorityName: 'priority',
    project_key: 'project',
    projectKey: 'project',
    timeestimate: 'originalEstimate',
    timetracking: 'originalEstimate',
};

function describe(key: string): string {
    const equivalent = EQUIVALENTS[key];

    return equivalent === undefined ? `"${key}"` : `"${key}" (es "${equivalent}")`;
}

/**
 * Esquema que rechaza los parámetros que no existen diciendo cómo se llaman
 * aquí. Un parámetro mal nombrado se descartaba en silencio y el issue nacía
 * sin lo que se le había puesto —sin asignado, sin estimación— sin que nada
 * lo señalara, así que el error nombra el equivalente y la lista completa.
 */
export function strictToolSchema<Shape extends z.ZodRawShape>(shape: Shape) {
    const accepted = Object.keys(shape);

    return z.strictObject(shape, {
        error: (issue) => {
            if (issue.code !== 'unrecognized_keys') {
                return undefined;
            }

            const unknown = issue.keys.map(describe).join(', ');

            return `Parámetros que no existen en esta herramienta: ${unknown}. Los admitidos son: ${accepted.join(', ')}.`;
        },
    });
}
