import axios from 'axios';

export function handleJiraError(error: unknown): never {
    if (axios.isAxiosError(error)) {
        const status = error.response?.status;

        const message =
            error.response?.data?.errorMessages?.join(', ') ??
            error.message;

        throw new Error(
            `Jira error (${status ?? 'unknown'}): ${message}`,
        );
    }

    throw error;
}