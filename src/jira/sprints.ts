import { createJiraClient } from './client.js';
import { handleJiraError } from './error.js';
import { normalizeName } from './names.js';

import type {
    JiraBoard,
    JiraCreateSprintInput,
    JiraSprint,
    JiraSprintMoveResult,
} from '../types/jira.js';

interface JiraApiBoard {
    id: number;
    name: string;
    type: string;
}

interface JiraApiBoardsResponse {
    values: JiraApiBoard[];
    isLast: boolean;
}

interface JiraApiSprint {
    id: number;
    name: string;
    state: string;
    startDate?: string;
    endDate?: string;
    goal?: string;
    originBoardId?: number;
}

interface JiraApiSprintsResponse {
    values: JiraApiSprint[];
    isLast: boolean;
}

/** Tope por página de los endpoints de Agile. */
const PAGE_SIZE = 50;

/**
 * Tope de sprints que se recorren al resolver uno por su nombre. Un tablero
 * veterano acumula cientos de sprints cerrados; sin límite, un nombre mal
 * escrito recorrería el historial entero antes de fallar.
 */
const MAX_SPRINTS = 500;

/** El endpoint rechaza la petición entera si se le envían más issues. */
const MOVE_BATCH_SIZE = 50;

interface BoardSelector {
    project?: string;
    boardId?: number;
}

/**
 * Traduce un error de Jira a texto sin interrumpir el flujo, para las
 * operaciones que continúan tras un fallo parcial.
 */
function describeError(error: unknown): string {
    try {
        handleJiraError(error);
    } catch (normalized) {
        return normalized instanceof Error
            ? normalized.message
            : String(normalized);
    }

    // Inalcanzable: handleJiraError siempre lanza.
    return String(error);
}

function toBoard(board: JiraApiBoard): JiraBoard {
    return { id: board.id, name: board.name, type: board.type };
}

/**
 * Normaliza una fecha al formato que espera la API de Agile.
 *
 * Una fecha suelta —`2026-08-15`— se ancla a medianoche UTC en lugar de a la
 * hora local: el sprint lo consulta gente en husos distintos y Jira solo
 * muestra el día, así que fijar el instante evita que la fecha se desplace al
 * día anterior para quien esté al oeste del meridiano.
 */
function normalizeDate(value: string, label: string): string {
    const trimmed = value.trim();

    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        return `${trimmed}T00:00:00.000Z`;
    }

    const parsed = new Date(trimmed);

    if (Number.isNaN(parsed.getTime())) {
        throw new Error(
            `La fecha de ${label} ("${value}") no es válida. Formatos admitidos: 2026-08-15 o 2026-08-15T09:00:00.000Z`,
        );
    }

    return parsed.toISOString();
}

async function fetchBoards(projectKey: string): Promise<JiraApiBoard[]> {
    const client = createJiraClient();

    const boards: JiraApiBoard[] = [];

    let isLast = false;

    while (!isLast) {
        const response = await client.get<JiraApiBoardsResponse>(
            '/rest/agile/1.0/board',
            {
                params: {
                    projectKeyOrId: projectKey,
                    startAt: boards.length,
                    maxResults: PAGE_SIZE,
                },
            },
        );

        boards.push(...response.data.values);

        isLast = response.data.isLast || response.data.values.length === 0;
    }

    return boards;
}

/**
 * Localiza el tablero sobre el que vive el sprint.
 *
 * Los sprints no cuelgan del proyecto sino de un tablero, y solo los de tipo
 * scrum los admiten: un proyecto kanban no tiene dónde crearlos. Quien pide
 * «crea el sprint de LAN» no tiene por qué conocer esa distinción, así que se
 * resuelve aquí y, cuando no hay una respuesta única, el error dice cuál es el
 * problema en lugar de dejar que Jira lo rechace por un identificador ausente.
 */
async function resolveBoard(selector: BoardSelector): Promise<JiraBoard> {
    if (selector.boardId !== undefined) {
        const client = createJiraClient();

        const response = await client.get<JiraApiBoard>(
            `/rest/agile/1.0/board/${selector.boardId}`,
        );

        return toBoard(response.data);
    }

    if (selector.project === undefined) {
        throw new Error(
            'Falta indicar el proyecto (project) o el tablero (boardId) sobre el que trabajar.',
        );
    }

    const boards = await fetchBoards(selector.project);

    const scrum = boards.filter((board) => board.type === 'scrum');

    if (scrum.length === 1) {
        return toBoard(scrum[0]);
    }

    if (scrum.length > 1) {
        const options = scrum
            .map((board) => `"${board.name}" (boardId: ${board.id})`)
            .join(', ');

        throw new Error(
            `El proyecto ${selector.project} tiene varios tableros scrum, así que hay que elegir uno con boardId. Tableros: ${options}`,
        );
    }

    if (boards.length > 0) {
        const options = boards
            .map((board) => `"${board.name}" (${board.type})`)
            .join(', ');

        throw new Error(
            `El proyecto ${selector.project} no tiene ningún tablero scrum, y los sprints solo existen en ese tipo de tablero. Tableros del proyecto: ${options}`,
        );
    }

    throw new Error(
        `El proyecto ${selector.project} no tiene ningún tablero. Un sprint necesita un tablero scrum donde crearse.`,
    );
}

async function fetchSprints(
    boardId: number,
    state: string,
): Promise<JiraApiSprint[]> {
    const client = createJiraClient();

    const sprints: JiraApiSprint[] = [];

    let isLast = false;

    while (!isLast && sprints.length < MAX_SPRINTS) {
        const response = await client.get<JiraApiSprintsResponse>(
            `/rest/agile/1.0/board/${boardId}/sprint`,
            {
                params: {
                    state,
                    startAt: sprints.length,
                    maxResults: PAGE_SIZE,
                },
            },
        );

        sprints.push(...response.data.values);

        isLast = response.data.isLast || response.data.values.length === 0;
    }

    return sprints;
}

function toSprint(sprint: JiraApiSprint, board: JiraBoard | null): JiraSprint {
    return {
        id: sprint.id,
        name: sprint.name,
        state: sprint.state,
        board,
        startDate: sprint.startDate ?? null,
        endDate: sprint.endDate ?? null,
        goal: sprint.goal ?? null,
    };
}

/**
 * Localiza un sprint por su identificador numérico o por su nombre.
 *
 * Por nombre hace falta el tablero, porque el nombre solo es único dentro de
 * él: dos proyectos pueden tener su propio «Sprint 1».
 */
async function resolveSprint(
    sprint: string,
    selector: BoardSelector,
): Promise<JiraApiSprint> {
    const wanted = sprint.trim();

    if (/^\d+$/.test(wanted)) {
        const client = createJiraClient();

        const response = await client.get<JiraApiSprint>(
            `/rest/agile/1.0/sprint/${wanted}`,
        );

        return response.data;
    }

    const board = await resolveBoard(selector);

    const needle = normalizeName(wanted);

    const open = await fetchSprints(board.id, 'future,active');

    const matches = open.filter(
        (candidate) => normalizeName(candidate.name) === needle,
    );

    if (matches.length === 1) {
        return matches[0];
    }

    if (matches.length > 1) {
        const options = matches
            .map((candidate) => `${candidate.id} (${candidate.state})`)
            .join(', ');

        throw new Error(
            `El tablero "${board.name}" tiene varios sprints llamados "${sprint}". Indicar cuál por su identificador: ${options}`,
        );
    }

    // Un sprint cerrado no admite issues, pero decir que «no existe» mandaría a
    // crearlo de nuevo cuando el problema es otro.
    const closed = await fetchSprints(board.id, 'closed');

    const finished = closed.find(
        (candidate) => normalizeName(candidate.name) === needle,
    );

    if (finished) {
        throw new Error(
            `El sprint "${sprint}" (${finished.id}) del tablero "${board.name}" está cerrado y ya no admite issues.`,
        );
    }

    const options = open.map((candidate) => `"${candidate.name}"`).join(', ');

    throw new Error(
        `No hay ningún sprint llamado "${sprint}" en el tablero "${board.name}". Sprints abiertos: ${options || 'ninguno'}`,
    );
}

/**
 * Crea un sprint en el tablero scrum del proyecto.
 *
 * El sprint nace en estado `future`: crearlo no lo arranca. Iniciarlo es una
 * decisión de equipo —cierra el anterior y fija el compromiso—, así que se deja
 * fuera a propósito y se hace desde Jira.
 */
export async function createSprint(
    input: JiraCreateSprintInput,
): Promise<JiraSprint> {
    try {
        const board = await resolveBoard({
            project: input.project,
            boardId: input.boardId,
        });

        if (board.type !== 'scrum') {
            throw new Error(
                `El tablero "${board.name}" (${board.id}) es de tipo ${board.type}, y los sprints solo existen en tableros scrum.`,
            );
        }

        const startDate =
            input.startDate !== undefined
                ? normalizeDate(input.startDate, 'inicio')
                : undefined;

        const endDate =
            input.endDate !== undefined
                ? normalizeDate(input.endDate, 'fin')
                : undefined;

        if (
            startDate !== undefined &&
            endDate !== undefined &&
            new Date(endDate) <= new Date(startDate)
        ) {
            throw new Error(
                `La fecha de fin (${input.endDate}) no es posterior a la de inicio (${input.startDate}).`,
            );
        }

        const client = createJiraClient();

        const response = await client.post<JiraApiSprint>(
            '/rest/agile/1.0/sprint',
            {
                name: input.name,
                originBoardId: board.id,
                ...(startDate !== undefined && { startDate }),
                ...(endDate !== undefined && { endDate }),
                ...(input.goal !== undefined && { goal: input.goal }),
            },
        );

        return toSprint(response.data, board);
    } catch (error) {
        handleJiraError(error);
    }
}

/**
 * Mueve issues a un sprint.
 *
 * Sirve igual para poblar un sprint recién creado que para reubicar issues
 * entre sprints: un issue solo pertenece a uno, así que moverlo lo saca del
 * anterior.
 */
export async function moveIssuesToSprint(
    sprint: string,
    issues: string[],
    selector: BoardSelector = {},
): Promise<JiraSprintMoveResult> {
    try {
        if (issues.length === 0) {
            throw new Error('No se ha indicado ningún issue que mover.');
        }

        const target = await resolveSprint(sprint, selector);

        if (target.state === 'closed') {
            throw new Error(
                `El sprint "${target.name}" (${target.id}) está cerrado y ya no admite issues.`,
            );
        }

        const client = createJiraClient();

        const moved: string[] = [];
        const failed: JiraSprintMoveResult['failed'] = [];

        // El endpoint aplica cada petición entera o ninguna, así que un lote que
        // falle no deshace los anteriores. Se informa lote a lote en vez de
        // propagar el primer error: quien reintentase a ciegas volvería a mover
        // issues que ya están en el sprint.
        for (let index = 0; index < issues.length; index += MOVE_BATCH_SIZE) {
            const batch = issues.slice(index, index + MOVE_BATCH_SIZE);

            try {
                await client.post(`/rest/agile/1.0/sprint/${target.id}/issue`, {
                    issues: batch,
                });

                moved.push(...batch);
            } catch (error) {
                failed.push({ issues: batch, error: describeError(error) });
            }
        }

        if (moved.length === 0) {
            throw new Error(
                `No se ha movido ningún issue al sprint "${target.name}" (${target.id}): ${failed
                    .map((batch) => batch.error)
                    .join('; ')}`,
            );
        }

        return {
            sprint: {
                id: target.id,
                name: target.name,
                state: target.state,
            },
            requested: issues.length,
            moved,
            ...(failed.length > 0 && { failed }),
        };
    } catch (error) {
        handleJiraError(error);
    }
}
