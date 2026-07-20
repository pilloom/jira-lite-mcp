import { z } from 'zod';

import { getServerVersion } from '../config/version.js';

export const pingTool = {
    name: 'ping',

    description:
        'Comprueba que el servidor Jira Lite MCP responde e indica qué código está ejecutando: versión declarada y fecha de compilación. Útil para distinguir una capacidad que no existe de una que existe pero no está desplegada en la sesión en curso.',

    inputSchema: z.object({}),

    async handler() {
        const version = getServerVersion();

        return {
            content: [
                {
                    type: 'text' as const,
                    text: JSON.stringify(
                        {
                            status: 'ok',
                            ...version,
                            note: 'El cliente MCP arranca el servidor al abrir la sesión: si "built" es anterior a la última compilación, hay que reiniciar la sesión para cargar el código nuevo.',
                        },
                        null,
                        2,
                    ),
                },
            ],
        };
    },
};
