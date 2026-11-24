import { z } from 'zod';

import { copyIssues } from '../jira/copy.js';

import { strictToolSchema } from './params.js';

import type { CopyIssuesInput } from '../jira/copy.js';

/** Lo que el cliente MCP pasa a cada llamada y se usa aquí: el aviso de avance. */
interface ToolExtra {
    _meta?: { progressToken?: string | number };
    sendNotification?: (notification: {
        method: 'notifications/progress';
        params: {
            progressToken: string | number;
            progress: number;
            total?: number;
            message?: string;
        };
    }) => Promise<void>;
}

export const copyIssuesTool = {
    name: 'jira_copy_issues',

    description:
        'Copia issues a otro proyecto de la misma instancia, con sus hijos, sin tocar los originales: una épica arrastra sus historias y tareas, y estas sus subtareas, y cada copia cuelga de la copia de su padre. Va en dos pasos. mode "plan" (por defecto) no cambia nada: lista lo que se copiaría, el tipo y el estado de cada copia, los campos con contenido que el destino no admite, los obligatorios que quedarían vacíos y los permisos, y devuelve un planId si no hay bloqueos. Un tipo o un estado sin equivalente es un bloqueo, nunca se adivina: se resuelve con typeMapping, statusMapping o targetStatus. mode "execute" con la misma entrada y ese planId crea las copias por niveles, enlaza cada una a su original («Cloners», o «Relates» si no existe), las lleva al estado, copia lo pedido en copy, rehace los enlaces y verifica cada copia. El texto rico se copia tal cual, con las casillas sin marcar. Si algo falla se detiene y dice qué se creó; repetir el plan con las mismas claves reconoce las copias ya hechas y continúa sin duplicar.',

    inputSchema: strictToolSchema({
        issueKeys: z
            .array(z.string())
            .min(1)
            .describe('Claves de los issues a copiar. Ejemplo: ["SIATY-1973", "SIATY-1500"]'),
        targetProject: z.string().describe('Clave del proyecto de destino. Ejemplo: GS'),
        includeChildren: z
            .boolean()
            .optional()
            .describe('Copiar también los hijos de cada issue, en todos los niveles. Por defecto true'),
        mode: z
            .enum(['plan', 'execute'])
            .optional()
            .describe('"plan" (por defecto) no modifica nada; "execute" copia y exige el planId del plan'),
        planId: z
            .string()
            .optional()
            .describe('Identificador que devolvió el plan. Obligatorio con mode "execute"'),
        typeMapping: z
            .record(z.string(), z.string())
            .optional()
            .describe('Tipo de origen → tipo de destino, por nombre, cuando no se llaman igual. Ejemplo: { "Historia": "Story" }'),
        statusMapping: z
            .record(z.string(), z.string())
            .optional()
            .describe('Estado de origen → estado de destino, por nombre, para los estados que no existen en el destino. Ejemplo: { "En revisión": "In Review" }'),
        targetStatus: z
            .string()
            .optional()
            .describe('Estado en que quedan todas las copias, por ejemplo "Tareas por hacer". Si no se indica, se reproduce el del original'),
        copy: z
            .array(z.enum(['comments', 'attachments', 'labels', 'assignee', 'worklogs']))
            .optional()
            .describe('Qué se copia además de los campos. Por defecto ["labels"]. Los comentarios y registros de tiempo empiezan con su autor y fecha originales, porque Jira los atribuye a quien copia; los registros de tiempo van fuera por defecto para no duplicar horas'),
        linkToOriginal: z
            .boolean()
            .optional()
            .describe('Dejar cada copia enlazada con su original. Por defecto true. Con false el enlace se crea igual mientras se copia, para poder continuar si algo falla, y se quita al terminar bien'),
        summaryPrefix: z
            .string()
            .optional()
            .describe('Texto delante del resumen de cada copia. Ejemplo: "[Copia] ". Por defecto ninguno'),
        preserveLostFields: z
            .boolean()
            .optional()
            .describe('Añadir al final de la descripción de la copia el contenido de los campos que el destino no admite. El original no se toca. Por defecto true'),
        notify: z
            .boolean()
            .optional()
            .describe('Avisar de los registros de tiempo copiados. Por defecto false. Jira avisa siempre del alta, los comentarios y las transiciones según el esquema de notificaciones del destino'),
        timeoutSeconds: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Tiempo máximo de la ejecución, en segundos. Por defecto 300, máximo 1800. Si se agota, repetir el plan continúa'),
    }),

    async handler(args: CopyIssuesInput, extra?: ToolExtra) {
        const token = extra?._meta?.progressToken;

        const result = await copyIssues(args, async (message, progress, total) => {
            if (token === undefined || !extra?.sendNotification) {
                return;
            }

            await extra
                .sendNotification({
                    method: 'notifications/progress',
                    params: { progressToken: token, progress, ...(total !== undefined && { total }), message },
                })
                .catch(() => undefined);
        });

        return {
            content: [
                {
                    type: 'text' as const,
                    text: JSON.stringify(result, null, 2),
                },
            ],
        };
    },
};
