import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from 'dotenv';

// El servidor se ejecuta desde el directorio del proyecto que lo consume, no
// desde el suyo, así que el fichero de entorno se busca junto al código en
// lugar de en el directorio de trabajo. Las variables ya presentes en el
// entorno tienen prioridad: permiten configurarlo desde el cliente MCP.
const moduleDirectory = dirname(fileURLToPath(import.meta.url));

config({ path: resolve(moduleDirectory, '../../.env') });

function getEnv(name: string): string | undefined {
    return process.env[name];
}

export const env = {
    jiraUrl: getEnv('JIRA_URL'),
    jiraEmail: getEnv('JIRA_EMAIL'),
    jiraToken: getEnv('JIRA_TOKEN'),
};

export function requireJiraConfig() {
    if (!env.jiraUrl || !env.jiraEmail || !env.jiraToken) {
        throw new Error(
            'Jira configuration missing. Required variables: JIRA_URL, JIRA_EMAIL, JIRA_TOKEN',
        );
    }

    return {
        jiraUrl: env.jiraUrl,
        jiraEmail: env.jiraEmail,
        jiraToken: env.jiraToken,
    };
}
