import { runJqlAll } from './search.js';

import type {
    JiraProjectSummary,
    JiraStaleIssue,
} from '../types/jira.js';

interface JiraSummaryFields {
    summary: string;
    status: {
        name: string;
    };
    issuetype: {
        name: string;
    };
    priority: {
        name: string;
    } | null;
    assignee: unknown | null;
    updated: string;
}

const FIELDS = [
    'summary',
    'status',
    'issuetype',
    'priority',
    'assignee',
    'updated',
];

const MAX_ISSUES = 1000;
const DEFAULT_STALE_DAYS = 14;
const STALE_SAMPLE = 5;

export interface ProjectSummaryOptions {
    project: string;
    staleDays?: number;
}

function count(values: string[]): Record<string, number> {
    const tally: Record<string, number> = {};

    for (const value of values) {
        tally[value] = (tally[value] ?? 0) + 1;
    }

    // De mayor a menor: lo abundante es lo que describe el estado del proyecto.
    return Object.fromEntries(
        Object.entries(tally).sort(([, a], [, b]) => b - a),
    );
}

function daysSince(timestamp: string, now: number): number {
    const elapsed = now - new Date(timestamp).getTime();

    return Math.floor(elapsed / (1000 * 60 * 60 * 24));
}

export async function getProjectSummary(
    options: ProjectSummaryOptions,
): Promise<JiraProjectSummary> {
    const staleDays = options.staleDays ?? DEFAULT_STALE_DAYS;

    // El JQL solo filtra por proyecto y categoría de estado. El reparto por
    // tipo se calcula aquí y no con una consulta por tipo: los nombres de tipo
    // en JQL son los canónicos en inglés, y usar el nombre mostrado devuelve
    // cero resultados sin dar error.
    const jql = `project = "${options.project}" AND statusCategory != Done ORDER BY updated DESC`;

    const page = await runJqlAll<JiraSummaryFields>(jql, FIELDS, MAX_ISSUES);

    const now = Date.now();

    const stale: JiraStaleIssue[] = [];

    let unassigned = 0;

    for (const issue of page.issues) {
        if (issue.fields.assignee === null) {
            unassigned += 1;
        }

        const days = daysSince(issue.fields.updated, now);

        if (days >= staleDays) {
            stale.push({
                key: issue.key,
                summary: issue.fields.summary,
                status: issue.fields.status.name,
                daysSinceUpdate: days,
            });
        }
    }

    stale.sort((a, b) => b.daysSinceUpdate - a.daysSinceUpdate);

    return {
        project: options.project,
        openIssues: page.issues.length,
        truncated: page.truncated,
        byStatus: count(page.issues.map((issue) => issue.fields.status.name)),
        byType: count(page.issues.map((issue) => issue.fields.issuetype.name)),
        byPriority: count(
            page.issues.map((issue) => issue.fields.priority?.name ?? 'Sin prioridad'),
        ),
        unassigned,
        stale: {
            days: staleDays,
            count: stale.length,
            oldest: stale.slice(0, STALE_SAMPLE),
        },
    };
}
