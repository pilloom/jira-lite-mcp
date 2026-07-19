import { createJiraClient } from './client.js';
import { handleJiraError } from './error.js';
import { normalizeName } from './names.js';

import type { JiraLinkResult, JiraLinkType } from '../types/jira.js';

interface JiraApiLinkType {
    id: string;
    name: string;
    inward: string;
    outward: string;
}

interface JiraApiLinkTypesResponse {
    issueLinkTypes: JiraApiLinkType[];
}

interface ResolvedRelation {
    type: JiraApiLinkType;
    /** Si la relación indicada es la inversa, los issues se envían al revés. */
    reversed: boolean;
}

/**
 * Interpreta la relación tal como se enuncia («blocks», «is blocked by»,
 * «relates to») y decide en qué orden deben viajar los issues.
 *
 * La API modela cada enlace en un solo sentido: `inwardIssue` <descripción
 * outward> `outwardIssue`. Enunciar la relación inversa es igual de natural
 * para quien la escribe, así que se acepta y se invierten los extremos.
 */
function resolveRelation(
    types: JiraApiLinkType[],
    relation: string,
): ResolvedRelation | undefined {
    const needle = normalizeName(relation);

    const outward = types.find(
        (type) =>
            normalizeName(type.outward) === needle ||
            normalizeName(type.name) === needle,
    );

    if (outward) {
        return { type: outward, reversed: false };
    }

    const inward = types.find((type) => normalizeName(type.inward) === needle);

    return inward ? { type: inward, reversed: true } : undefined;
}

export async function getLinkTypes(): Promise<JiraLinkType[]> {
    try {
        const client = createJiraClient();

        const response = await client.get<JiraApiLinkTypesResponse>(
            '/rest/api/3/issueLinkType',
        );

        return response.data.issueLinkTypes.map((type) => ({
            name: type.name,
            outward: type.outward,
            inward: type.inward,
        }));
    } catch (error) {
        handleJiraError(error);
    }
}

export async function linkIssues(
    issueKey: string,
    relation: string,
    targetKey: string,
): Promise<JiraLinkResult> {
    try {
        const client = createJiraClient();

        const response = await client.get<JiraApiLinkTypesResponse>(
            '/rest/api/3/issueLinkType',
        );

        const resolved = resolveRelation(response.data.issueLinkTypes, relation);

        if (!resolved) {
            const options = response.data.issueLinkTypes
                .map((type) => `"${type.outward}" / "${type.inward}"`)
                .join(', ');

            throw new Error(
                `La relación "${relation}" no existe en esta instancia. Relaciones posibles: ${options}`,
            );
        }

        const [inward, outward] = resolved.reversed
            ? [targetKey, issueKey]
            : [issueKey, targetKey];

        await client.post('/rest/api/3/issueLink', {
            type: { name: resolved.type.name },
            inwardIssue: { key: inward },
            outwardIssue: { key: outward },
        });

        return {
            from: inward,
            relation: resolved.type.outward,
            to: outward,
        };
    } catch (error) {
        handleJiraError(error);
    }
}
