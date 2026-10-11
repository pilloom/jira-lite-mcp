import { createJiraClient } from './client.js';
import { handleJiraError } from './error.js';
import { transitionIssue } from './transitions.js';
import { updateIssue } from './update.js';
import { getCurrentUser } from './users.js';

import type { JiraClaimResult, JiraUser } from '../types/jira.js';

import type { AxiosInstance } from 'axios';

/**
 * Lo justo para decidir si la tarea está libre y de quién es después. No se
 * reutiliza `getIssue` porque ese devuelve el asignado **solo por su nombre
 * visible**, y aquí la comparación tiene que ser por `accountId`: dos personas
 * pueden compartir nombre visible, y quien se llame igual que uno se leería
 * como uno mismo.
 */
const CAMPOS = 'assignee,status,summary';

interface Leido {
    summary: string;
    status: string;
    /** `new`, `indeterminate` o `done`. */
    category: string;
    assignee: { accountId: string; displayName: string } | null;
}

/**
 * Recorta el usuario de Jira a lo que esta herramienta decide con él.
 *
 * 🔴 **Explícito, no por tipo.** Devolver `fields.assignee` tal cual lo colaba
 * entero en la respuesta —`self`, `avatarUrls`, `timeZone`, `accountType` y el
 * **correo** de la persona— aunque el tipo declarase dos campos: un tipo de
 * menos describe mal la respuesta de Jira, no la recorta. Medido el 2026-10-11
 * llamando a la herramienta ya desplegada.
 */
function quienEs(assignee: Record<string, unknown> | null): Leido['assignee'] {
    if (assignee === null) {
        return null;
    }

    return {
        accountId: String(assignee.accountId ?? ''),
        displayName: String(assignee.displayName ?? ''),
    };
}

async function leer(client: AxiosInstance, issueKey: string): Promise<Leido> {
    const response = await client.get<{
        fields: {
            summary: string;
            status: { name: string; statusCategory: { key: string } };
            /**
             * El usuario **como lo manda Jira**, con todo lo que trae. Se
             * declara entero —y no solo los dos campos que se usan— porque
             * tiparlo de menos no recorta la respuesta: deja pasar el objeto
             * crudo creyendo que es el recortado, que es justo lo que hacía
             * esta función.
             */
            assignee: Record<string, unknown> | null;
        };
    }>(`/rest/api/3/issue/${issueKey}`, { params: { fields: CAMPOS } });

    const fields = response.data.fields;

    return {
        summary: fields.summary,
        status: fields.status.name,
        // 🔴 Por `statusCategory.key`, no por el nombre del estado. El nombre lo
        // pone cada workflow y además va en el idioma del sitio: comparar contra
        // "En curso" daría por no empezado cualquier estado renombrado o nuevo
        // —en LAN, «En curso» y «EN REVISION» son los dos `indeterminate`—, y
        // dar por libre lo que ya tiene a alguien dentro es justo el fallo que
        // esta herramienta existe para evitar.
        category: fields.status.statusCategory.key,
        assignee: quienEs(fields.assignee),
    };
}

/**
 * Transiciona después de haber ganado la asignación. Un fallo aquí **no**
 * deshace la toma: la asignación ya está escrita y es ella la que reserva la
 * tarea, así que se informa del fallo sin negar lo que sí se hizo. Propagar el
 * error a secas diría que no se tomó nada y llevaría a reintentar sobre algo
 * que ya es de quien llama.
 */
async function transicionar(
    issueKey: string,
    to: string,
): Promise<Pick<JiraClaimResult, 'transitioned' | 'transitionError'>> {
    try {
        const result = await transitionIssue(issueKey, to);

        return {
            transitioned: { status: result.status, transition: result.transition },
        };
    } catch (error) {
        return {
            transitionError:
                error instanceof Error ? error.message : String(error),
        };
    }
}

function quien(assignee: Leido['assignee']): string {
    return assignee === null ? 'sin asignar' : assignee.displayName;
}

/**
 * Toma una tarea: comprueba contra Jira que está libre, se la asigna a quien
 * llama y **vuelve a leerla** para confirmar que quedó a su nombre.
 *
 * 🔑 **La relectura es la razón de que esto sea una herramienta y no tres
 * llamadas seguidas.** Jira no ofrece escritura condicional sobre `assignee`:
 * si dos personas asignan a la vez, la segunda escritura gana y Jira **no
 * avisa a la primera**. Sin releer, las dos se van convencidas de tenerla y
 * hacen el trabajo dos veces, que es el caso que se quería cerrar. Releyendo,
 * la que perdió lee el nombre de la otra y se retira.
 *
 * ⚠️ **No es una toma atómica, y no se presenta como tal.** Entre la escritura
 * y la relectura sigue habiendo una ventana: si la otra persona escribe justo
 * ahí, las dos pueden leerse a sí mismas. Lo que se consigue es reducir esa
 * ventana a los milisegundos de dos peticiones, en vez de las horas que lleva
 * desfasada una mesa generada por la mañana. Para cerrarla del todo haría falta
 * algo que Jira no da.
 *
 * El orden —asignar, releer, y transicionar solo si se ganó— tampoco es
 * casual: transicionar antes dejaría «En curso» una tarea que acaba de ser de
 * otra persona, y el estado es lo que el resto del equipo lee como «esta ya la
 * están haciendo».
 */
export async function claimIssue(
    issueKey: string,
    to?: string,
): Promise<JiraClaimResult> {
    try {
        const client = createJiraClient();

        const yo: JiraUser = await getCurrentUser();

        const antes = await leer(client, issueKey);

        const base = {
            key: issueKey,
            url: `${client.defaults.baseURL}/browse/${issueKey}`,
            summary: antes.summary,
        };

        if (antes.category === 'done') {
            return {
                ...base,
                claimed: false,
                reason: 'done',
                message: `${issueKey} está cerrada (${antes.status}): no hay nada que tomar.`,
                assignee: antes.assignee,
                status: antes.status,
            };
        }

        // Ya era suya: la llamada se repite sin consecuencias. Se comprueba antes
        // que «la tiene otra persona» para que repetir `/tomar` no se lea como
        // una colisión consigo mismo.
        if (antes.assignee?.accountId === yo.accountId) {
            const transition = to === undefined ? {} : await transicionar(issueKey, to);

            return {
                ...base,
                claimed: true,
                alreadyMine: true,
                message: `${issueKey} ya era tuya. No se ha reasignado nada.`,
                assignee: antes.assignee,
                // El de la transición si la hubo: `status` y `transitioned.status`
                // en la misma respuesta diciendo estados distintos es una
                // contradicción, y se leería como que la transición no se aplicó.
                status: transition.transitioned?.status ?? antes.status,
                ...transition,
            };
        }

        if (antes.assignee !== null) {
            return {
                ...base,
                claimed: false,
                reason: 'taken',
                message: `${issueKey} ya la tiene ${antes.assignee.displayName}. No la tomes: háblalo primero.`,
                assignee: antes.assignee,
                status: antes.status,
            };
        }

        if (antes.category === 'indeterminate') {
            return {
                ...base,
                claimed: false,
                reason: 'started-unassigned',
                message: `${issueKey} está sin asignar pero ya empezada (${antes.status}): alguien la está haciendo sin haberse asignado. Averigua quién antes de tomarla.`,
                assignee: null,
                status: antes.status,
            };
        }

        await updateIssue({ issueKey, assignee: yo.accountId });

        const despues = await leer(client, issueKey);

        if (despues.assignee?.accountId !== yo.accountId) {
            return {
                ...base,
                claimed: false,
                reason: 'lost-race',
                message: `La asignación de ${issueKey} se escribió, pero al releerla la tiene ${quien(despues.assignee)}: se os cruzó la toma y la perdiste. No empieces.`,
                assignee: despues.assignee,
                status: despues.status,
            };
        }

        const transition = to === undefined ? {} : await transicionar(issueKey, to);

        return {
            ...base,
            claimed: true,
            message: `${issueKey} es tuya, confirmado releyéndola en Jira.`,
            assignee: despues.assignee,
            status: transition.transitioned?.status ?? despues.status,
            ...transition,
        };
    } catch (error) {
        handleJiraError(error);
    }
}
