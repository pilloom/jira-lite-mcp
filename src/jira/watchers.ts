import { createJiraClient } from './client.js';
import { handleJiraError } from './error.js';
import { resolveAccountId } from './users.js';

/**
 * Añade observadores a un issue. La API los trata de uno en uno y con una
 * petición propia por cada uno, así que se encapsula aquí la repetición.
 * Acepta correos o nombres visibles además de identificadores de cuenta.
 */
export async function addWatchers(
    issueKey: string,
    people: string[],
): Promise<string[]> {
    try {
        const client = createJiraClient();

        const accountIds = await Promise.all(people.map(resolveAccountId));

        for (const accountId of accountIds) {
            await client.post(
                `/rest/api/3/issue/${issueKey}/watchers`,
                JSON.stringify(accountId),
            );
        }

        return accountIds;
    } catch (error) {
        handleJiraError(error);
    }
}
