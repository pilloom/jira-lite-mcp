import { adfToMarkdown } from './adf.js';
import { createJiraClient } from './client.js';
import { handleJiraError } from './error.js';
import {
    extraFieldIds,
    readExtraFields,
    resolveExtraFields,
} from './extra-fields.js';
import { getTransitions } from './transitions.js';

import type {
    JiraIssueContext,
    JiraIssueComment,
    JiraLinkedIssue,
    JiraSubtask,
} from '../types/jira.js';

interface JiraApiRelatedIssue {
    key: string;
    fields: {
        summary: string;
        status: {
            name: string;
        };
    };
}

interface JiraApiComment {
    id: string;
    author: {
        displayName: string;
    };
    created: string;
    body: unknown;
}

interface JiraApiIssueContext {
    key: string;
    fields: {
        summary: string;
        status: { name: string };
        issuetype: { name: string };
        priority: { name: string } | null;
        assignee: { displayName: string } | null;
        reporter: { displayName: string } | null;
        created: string;
        updated: string;
        description: unknown;
        labels: string[];
        parent?: JiraApiRelatedIssue;
        subtasks?: JiraApiRelatedIssue[];
        issuelinks?: Array<{
            id: string;
            type: { inward: string; outward: string };
            inwardIssue?: JiraApiRelatedIssue;
            outwardIssue?: JiraApiRelatedIssue;
        }>;
        comment?: {
            comments: JiraApiComment[];
            total: number;
        };
        [key: string]: unknown;
    };
}

const BASE_FIELDS = [
    'summary',
    'status',
    'issuetype',
    'priority',
    'assignee',
    'reporter',
    'created',
    'updated',
    'description',
    'labels',
    'parent',
    'subtasks',
    'issuelinks',
    'comment',
];

const RECENT_COMMENTS = 5;

function toRelated(issue: JiraApiRelatedIssue): JiraSubtask {
    return {
        key: issue.key,
        summary: issue.fields.summary,
        status: issue.fields.status.name,
    };
}

export async function explainIssue(
    issueKey: string,
    extraFieldNames: string[] = [],
): Promise<JiraIssueContext> {
    try {
        const extra = await resolveExtraFields(extraFieldNames);

        const client = createJiraClient();

        // Las transiciones viven en otro endpoint; se piden a la vez para que
        // el contexto completo cueste una sola espera.
        const [response, transitions] = await Promise.all([
            client.get<JiraApiIssueContext>(`/rest/api/3/issue/${issueKey}`, {
                params: {
                    fields: [...BASE_FIELDS, ...extraFieldIds(extra)].join(','),
                },
            }),
            getTransitions(issueKey),
        ]);

        const fields = response.data.fields;

        // Jira admite enlazar el mismo par de issues en ambos sentidos. Con
        // una relación simétrica como «relates to» eso produce dos entradas
        // que se leen igual, así que se colapsan en una.
        const links: JiraLinkedIssue[] = [];
        const seenLinks = new Set<string>();

        for (const link of fields.issuelinks ?? []) {
            const related = link.outwardIssue ?? link.inwardIssue;

            if (!related) {
                continue;
            }

            const relation = link.outwardIssue
                ? link.type.outward
                : link.type.inward;

            const signature = `${relation}::${related.key}`;

            if (seenLinks.has(signature)) {
                continue;
            }

            seenLinks.add(signature);

            links.push({
                linkId: link.id,
                relation,
                key: related.key,
                summary: related.fields.summary,
                status: related.fields.status.name,
            });
        }

        const allComments = fields.comment?.comments ?? [];

        const comments: JiraIssueComment[] = allComments
            .slice(-RECENT_COMMENTS)
            .map((comment) => ({
                id: comment.id,
                author: comment.author.displayName,
                created: comment.created.slice(0, 10),
                body: adfToMarkdown(comment.body) ?? '',
            }));

        const customFields = readExtraFields(
            extra,
            response.data.key,
            fields,
        );

        return {
            key: response.data.key,
            summary: fields.summary,
            type: fields.issuetype.name,
            status: fields.status.name,
            priority: fields.priority?.name ?? null,
            assignee: fields.assignee?.displayName ?? null,
            reporter: fields.reporter?.displayName ?? null,
            created: fields.created.slice(0, 10),
            updated: fields.updated.slice(0, 10),
            labels: fields.labels,
            parent: fields.parent ? toRelated(fields.parent) : null,
            description: adfToMarkdown(fields.description),
            subtasks: (fields.subtasks ?? []).map(toRelated),
            links,
            comments,
            totalComments: fields.comment?.total ?? 0,
            availableTransitions: transitions.map(
                (transition) => transition.to,
            ),
            ...(extra.length > 0 && { customFields }),
        };
    } catch (error) {
        handleJiraError(error);
    }
}
