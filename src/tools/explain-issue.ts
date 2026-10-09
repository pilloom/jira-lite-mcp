import { z } from 'zod';

import { explainIssue } from '../jira/explain.js';

const RENAMED =
    '`extraFields` es el nombre anterior de este parámetro y se sigue aceptando, pero el nombre vigente en las tres herramientas de lectura es `fields`.';

export const explainIssueTool = {
    name: 'jira_explain_issue',

    description:
        'Devuelve un issue con todo su contexto en una sola llamada: descripción en markdown, issue padre, subtareas, issues enlazados, comentarios recientes y estados a los que puede moverse. Los campos personalizados no se devuelven si no se piden: hay que nombrarlos en "fields", y su ausencia en la respuesta no significa que el issue no los tenga. Si varios campos de la instancia comparten ese nombre y más de uno aplica al issue, el error enumera sus identificadores en lugar de devolver un valor vacío. Los campos de texto rico conservan su estructura: listas de tareas con el estado de cada casilla, listas, encabezados, negrita y código. Pensado para entender un ticket completo sin encadenar varias consultas.',

    inputSchema: z.strictObject({
        issueKey: z.string().describe('Clave del issue. Ejemplo: ATY-123'),
        fields: z
            .array(z.string())
            .optional()
            .describe(
                'Campos adicionales a incluir, por su nombre visible o su identificador. Ejemplo: ["Criterios de aceptación"]',
            ),
        extraFields: z
            .array(z.string())
            .optional()
            .describe(`Nombre anterior de \`fields\`. ${RENAMED}`),
    }),

    async handler(args: {
        issueKey: string;
        fields?: string[];
        extraFields?: string[];
    }) {
        const result = await explainIssue(
            args.issueKey,
            args.fields ?? args.extraFields,
        );

        // El cambio de nombre se avisa en la respuesta en vez de rechazar el
        // nombre viejo: una llamada que funcionaba no debe empezar a fallar, y
        // un parámetro aceptado en silencio no se llega a migrar nunca.
        const warning =
            args.extraFields === undefined
                ? undefined
                : args.fields === undefined
                  ? RENAMED
                  : `Se han recibido \`fields\` y \`extraFields\`: se ha usado \`fields\` y \`extraFields\` se ha ignorado. ${RENAMED}`;

        return {
            content: [
                {
                    type: 'text' as const,
                    text: JSON.stringify(
                        { ...(warning !== undefined && { warning }), ...result },
                        null,
                        2,
                    ),
                },
            ],
        };
    },
};
