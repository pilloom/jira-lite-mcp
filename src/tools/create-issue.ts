import { z } from 'zod';

import { createIssue } from '../jira/create.js';

import type { JiraCreateIssueInput } from '../types/jira.js';

export const createIssueTool = {
    name: 'jira_create_issue',

    description:
        'Crea un issue en Jira. Valida los campos contra el esquema real del proyecto y del tipo de issue antes de enviarlos, de modo que un payload incorrecto falle sin consumir una clave de issue. Los campos personalizados se indican por su nombre visible o por su identificador, y la persona asignada admite correo o nombre además del accountId. Con dryRun se comprueba el resultado sin crear nada. Conviene consultar antes jira_issue_fields para conocer los campos disponibles.',

    inputSchema: z.object({
        project: z
            .string()
            .describe('Clave del proyecto de Jira. Ejemplo: ATY'),
        issueType: z
            .string()
            .describe('Nombre o id del tipo de issue. Ejemplo: Tarea'),
        summary: z.string().describe('Título del issue'),
        description: z
            .string()
            .optional()
            .describe('Descripción en texto plano'),
        parent: z
            .string()
            .optional()
            .describe(
                'Clave del issue padre. Obligatorio en subtareas. Ejemplo: ATY-123',
            ),
        assignee: z
            .string()
            .optional()
            .describe(
                'Persona asignada: correo, nombre visible o accountId. Ejemplo: alguien@example.com',
            ),
        originalEstimate: z
            .string()
            .optional()
            .describe(
                'Estimación inicial en el formato de Jira. Ejemplos: 30m, 1h 30m, 8h',
            ),
        watchers: z
            .array(z.string())
            .optional()
            .describe(
                'Observadores a añadir: correos, nombres visibles o accountIds',
            ),
        dryRun: z
            .boolean()
            .optional()
            .describe(
                'Valida el payload contra el esquema real y devuelve lo que se enviaría, sin crear el issue',
            ),
        priority: z
            .string()
            .optional()
            .describe('Nombre de la prioridad. Ejemplo: High'),
        labels: z.array(z.string()).optional().describe('Etiquetas del issue'),
        customFields: z
            .record(z.string(), z.unknown())
            .optional()
            .describe(
                'Campos personalizados por nombre o identificador. Ejemplo: { "Criterios de aceptación": "[ ] Primero" }',
            ),
    }),

    async handler(args: JiraCreateIssueInput) {
        const issue = await createIssue(args);

        return {
            content: [
                {
                    type: 'text' as const,
                    text: JSON.stringify(issue, null, 2),
                },
            ],
        };
    },
};
