import { runJql } from './search.js';
import { getCurrentUser } from './users.js';

import type { JiraMyWorkResult, JiraWorkItem } from '../types/jira.js';

interface JiraMyWorkFields {
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
    updated: string;
}

const FIELDS = ['summary', 'status', 'issuetype', 'priority', 'updated'];

export interface MyWorkOptions {
    project?: string;
    limit?: number;
    includeDone?: boolean;
}

/**
 * Descarta la hora de la marca temporal de Jira. La fecha basta para situar
 * un issue en el tiempo y evita arrastrar zona horaria y milisegundos.
 */
function toDate(timestamp: string): string {
    return timestamp.slice(0, 10);
}

function buildJql(options: MyWorkOptions): string {
    const clauses = ['assignee = currentUser()'];

    if (options.project !== undefined) {
        clauses.push(`project = "${options.project}"`);
    }

    // Se filtra por categoría, no por nombre de estado: `To Do`, `In Progress`
    // y `Done` son invariantes de Jira, mientras que el nombre del estado
    // depende del workflow y del idioma del sitio.
    if (options.includeDone !== true) {
        clauses.push('statusCategory != Done');
    }

    return `${clauses.join(' AND ')} ORDER BY updated DESC`;
}

export async function getMyWork(
    options: MyWorkOptions = {},
): Promise<JiraMyWorkResult> {
    const [user, page] = await Promise.all([
        getCurrentUser(),
        runJql<JiraMyWorkFields>(buildJql(options), FIELDS, options.limit),
    ]);

    const issues: JiraWorkItem[] = page.issues.map((issue) => ({
        key: issue.key,
        summary: issue.fields.summary,
        type: issue.fields.issuetype.name,
        status: issue.fields.status.name,
        priority: issue.fields.priority?.name ?? null,
        updated: toDate(issue.fields.updated),
    }));

    return {
        user: user.displayName,
        count: issues.length,
        hasMore: page.hasMore,
        issues,
    };
}
