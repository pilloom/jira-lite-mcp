import { z } from 'zod';

export const pingTool = {
    name: 'ping',

    description:
        'Verifica que el servidor Jira Lite MCP está funcionando correctamente.',

    inputSchema: z.object({}),

    async handler() {
        return {
            content: [
                {
                    type: 'text' as const,
                    text: 'pong - Jira Lite MCP funcionando correctamente',
                },
            ],
        };
    },
};