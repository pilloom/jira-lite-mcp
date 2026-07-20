import { adfToText, textToAdf } from './adf.js';
import { createJiraClient } from './client.js';
import { handleJiraError } from './error.js';

import type {
    JiraWorklogEntry,
    JiraWorklogList,
    JiraWorklogResult,
} from '../types/jira.js';

interface JiraApiWorklogResponse {
    id: string;
    timeSpent: string;
    timeSpentSeconds: number;
    started: string;
}

interface JiraApiWorklogEntry {
    id: string;
    author: {
        displayName: string;
    };
    timeSpent: string;
    timeSpentSeconds: number;
    started: string;
    comment?: unknown;
}

interface JiraApiWorklogList {
    worklogs: JiraApiWorklogEntry[];
    total: number;
}

interface JiraApiTimeTracking {
    fields: {
        timetracking: {
            originalEstimate?: string;
            remainingEstimate?: string;
            timeSpent?: string;
        };
    };
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

        // El sufijo de días depende de la jornada configurada en el sitio, que
        // rara vez coincide con las 24 horas que uno supondría. Se explicita la
        // equivalencia para que no haya que deducirla de los segundos.
        const usesDays = /\d\s*d\b/i.test(input.timeSpent);

        const hours = response.data.timeSpentSeconds / 3600;

        return {
            key: input.issueKey,
            id: response.data.id,
            timeSpent: response.data.timeSpent,
            timeSpentSeconds: response.data.timeSpentSeconds,
            started: response.data.started.slice(0, 10),
            ...(usesDays && {
                note: `"${input.timeSpent}" se ha registrado como ${hours} h según la jornada configurada en este sitio. Para no depender de esa configuración, indicar el tiempo en horas.`,
            }),
        };
    } catch (error) {
        handleJiraError(error);
    }
}

/**
 * Registros de tiempo de un issue junto con su estimación. Los identificadores
 * se incluyen porque son necesarios para eliminar un registro concreto.
 */
export async function getWorklog(issueKey: string): Promise<JiraWorklogList> {
    try {
        const client = createJiraClient();

        const [list, issue] = await Promise.all([
            client.get<JiraApiWorklogList>(
                `/rest/api/3/issue/${issueKey}/worklog`,
            ),
            client.get<JiraApiTimeTracking>(`/rest/api/3/issue/${issueKey}`, {
                params: { fields: 'timetracking' },
            }),
        ]);

        const entries: JiraWorklogEntry[] = list.data.worklogs.map((entry) => ({
            id: entry.id,
            author: entry.author.displayName,
            timeSpent: entry.timeSpent,
            timeSpentSeconds: entry.timeSpentSeconds,
            started: entry.started.slice(0, 10),
            comment: adfToText(entry.comment),
        }));

        const timetracking = issue.data.fields.timetracking;

        return {
            key: issueKey,
            originalEstimate: timetracking.originalEstimate ?? null,
            // Lo calcula Jira según la jornada configurada en el sitio, así que
            // se toma tal cual en lugar de formatear los segundos aquí.
            totalSpent: timetracking.timeSpent ?? null,
            totalSpentSeconds: entries.reduce(
                (total, entry) => total + entry.timeSpentSeconds,
                0,
            ),
            count: list.data.total,
            worklogs: entries,
        };
    } catch (error) {
        handleJiraError(error);
    }
}
