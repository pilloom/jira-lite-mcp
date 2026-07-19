import { textToAdf } from './adf.js';
import { createJiraClient } from './client.js';
import { handleJiraError } from './error.js';

import type { JiraWorklogResult } from '../types/jira.js';

interface JiraApiWorklogResponse {
    id: string;
    timeSpent: string;
    timeSpentSeconds: number;
    started: string;
}

export interface WorklogInput {
    issueKey: string;
    timeSpent: string;
    comment?: string;
    started?: string;
}

/**
 * Traduce una fecha al formato que exige el worklog: `yyyy-MM-ddTHH:mm:ss.SSSZ`
 * con el desfase horario sin dos puntos. La forma ISO habitual —terminada en
 * `Z`— es rechazada por este endpoint.
 */
function toJiraTimestamp(value: string): string {
    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        throw new Error(
            `La fecha "${value}" no es válida. Se espera una fecha ISO, por ejemplo 2026-07-19T09:00:00`,
        );
    }

    return `${date.toISOString().replace('Z', '')}+0000`;
}

export async function addWorklog(
    input: WorklogInput,
): Promise<JiraWorklogResult> {
    try {
        const client = createJiraClient();

        const response = await client.post<JiraApiWorklogResponse>(
            `/rest/api/3/issue/${input.issueKey}/worklog`,
            {
                // El tiempo se envía tal cual: la duración de la jornada la
                // define la instancia, así que no corresponde a este servidor
                // decidir cuántas horas son un día.
                timeSpent: input.timeSpent,
                ...(input.comment !== undefined && {
                    comment: textToAdf(input.comment),
                }),
                ...(input.started !== undefined && {
                    started: toJiraTimestamp(input.started),
                }),
            },
        );

        return {
            key: input.issueKey,
            id: response.data.id,
            timeSpent: response.data.timeSpent,
            timeSpentSeconds: response.data.timeSpentSeconds,
            started: response.data.started.slice(0, 10),
        };
    } catch (error) {
        handleJiraError(error);
    }
}
