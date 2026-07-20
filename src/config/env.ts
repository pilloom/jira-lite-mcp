import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from 'dotenv';

const VARIABLES = ['JIRA_URL', 'JIRA_EMAIL', 'JIRA_TOKEN'] as const;

/**
 * Un cliente MCP que no encuentra la variable referenciada en su configuración
 * entrega el marcador sin sustituir —`${JIRA_TOKEN}`— en lugar de omitirlo.
 */
function isUnexpandedPlaceholder(value: string): boolean {
    return value.startsWith('${') && value.endsWith('}');
}

// Se descartan antes de leer el fichero de entorno: dotenv respeta lo que ya
// esté definido, así que un marcador sin sustituir impediría cargar el valor
// real y acabaría en un error de autenticación difícil de atribuir.
for (const name of VARIABLES) {
    const value = process.env[name];

    if (value !== undefined && (value === '' || isUnexpandedPlaceholder(value))) {
        delete process.env[name];
    }
}

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

/**
 * Campos que el equipo considera obligatorios aunque Jira no los marque como
 * tales. Jira no avisa de su ausencia, así que sin esta comprobación el olvido
 * pasa desapercibido hasta que alguien revisa el issue.
 *
 * Se define por proyecto —`JIRA_REQUIRED_FIELDS_LAN`— o para todos ellos con
 * `JIRA_REQUIRED_FIELDS`, en ambos casos como nombres separados por comas.
 */
export function getRequiredByPolicy(projectKey: string): string[] {
    const specific = getEnv(
        `JIRA_REQUIRED_FIELDS_${projectKey.toUpperCase()}`,
    );

    const general = getEnv('JIRA_REQUIRED_FIELDS');

    const value = specific ?? general;

    if (value === undefined) {
        return [];
    }

    return value
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
}

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
