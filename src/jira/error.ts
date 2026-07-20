import axios from 'axios';

interface JiraApiError {
    /** Errores generales, sin campo asociado. */
    errorMessages?: string[];
    /** Errores por campo, indexados por su identificador. */
    errors?: Record<string, string>;
}

/**
 * Normaliza los errores de Jira a un mensaje legible.
 *
 * La API reparte los motivos entre dos sitios: los generales en una lista y los
 * de campo concreto en un objeto. Leer solo la lista deja sin explicación
 * precisamente los rechazos por un valor inválido, que son los más frecuentes
 * al escribir y los únicos que indican qué corregir.
 */
export function handleJiraError(error: unknown): never {
    if (axios.isAxiosError(error)) {
        const status = error.response?.status;

        const data = error.response?.data as JiraApiError | undefined;

        const reasons = [
            ...(data?.errorMessages ?? []),
            ...Object.entries(data?.errors ?? {}).map(
                ([field, reason]) => `${field}: ${reason}`,
            ),
        ];

        const message =
            reasons.length > 0 ? reasons.join(', ') : error.message;

        throw new Error(`Jira error (${status ?? 'unknown'}): ${message}`);
    }

    throw error;
}
