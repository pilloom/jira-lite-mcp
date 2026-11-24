import { z } from 'zod';

import { moveIssues } from '../jira/move.js';

import { strictToolSchema } from './params.js';

import type { MoveIssuesInput } from '../jira/move.js';

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

export const moveIssuesTool = {
    name: 'jira_move_issues',

    description:
        'Mueve issues a otro proyecto de la misma instancia, con sus hijos: una épica arrastra sus historias y tareas, y estas sus subtareas. Va en dos pasos. mode "plan" (por defecto) no cambia nada: lista lo que se movería, el tipo y el estado que tendría cada issue en el destino, los campos con contenido que el destino no admite y los permisos, y devuelve un planId si no hay bloqueos. Un tipo o un estado sin equivalente es un bloqueo, nunca se adivina: se resuelve con typeMapping o statusMapping. mode "execute" con la misma entrada y ese planId repite las comprobaciones, copia al final de la descripción el contenido de los campos que se perderían (preserveLostFields), mueve por fases —Jira no mueve una épica y sus hijos en la misma petición— y verifica cada issue. Si algo falla a medias, se detiene y dice qué se movió y qué no: Jira no deshace un movimiento. Comentarios, registros de tiempo, adjuntos, historial y enlaces los conserva Jira. No avisa por correo salvo con notify: true.',

    inputSchema: strictToolSchema({
        issueKeys: z
            .array(z.string())
            .min(1)
            .describe('Claves de los issues a mover. Ejemplo: ["SIATY-1973", "SIATY-1500"]'),
        targetProject: z
            .string()
            .describe('Clave del proyecto de destino. Ejemplo: GS'),
        includeChildren: z
            .boolean()
            .optional()
            .describe('Incluir los hijos de cada issue, en todos los niveles. Por defecto true'),
        mode: z
            .enum(['plan', 'execute'])
            .optional()
            .describe('"plan" (por defecto) no modifica nada; "execute" mueve y exige el planId del plan'),
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
        preserveLostFields: z
            .boolean()
            .optional()
            .describe('Antes de mover, añadir al final de la descripción el contenido de los campos que el destino no admite. Por defecto true'),
        notify: z
            .boolean()
            .optional()
            .describe('Avisar por correo a los observadores. Por defecto false'),
        timeoutSeconds: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Tiempo máximo de espera a que Jira termine, en segundos. Por defecto 300, máximo 1800'),
    }),

    async handler(args: MoveIssuesInput, extra?: ToolExtra) {
        const token = extra?._meta?.progressToken;

        const result = await moveIssues(args, async (message, progress, total) => {
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
