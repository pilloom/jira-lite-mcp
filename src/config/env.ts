import 'dotenv/config';

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