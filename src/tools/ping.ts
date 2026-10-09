import { z } from 'zod';

import { getServerVersion } from '../config/version.js';

export const pingTool = {
    name: 'ping',

    description:
        'Comprueba que el servidor Jira Lite MCP responde e indica qué código está ejecutando **este proceso**: versión y fecha del código cargado, hora de arranque, y si hay código compilado más reciente que no ha cargado (campo "stale"), que es el caso en el que las herramientas responden con el código anterior. El campo "note" dice siempre el resultado de esa comprobación. Útil para distinguir una capacidad que no existe de una que existe pero no está desplegada en la sesión en curso.',

    inputSchema: z.object({}),

    async handler() {
        const version = getServerVersion();

        return {
            content: [
                {
                    type: 'text' as const,
                    text: JSON.stringify(
                        { status: 'ok', ...version },
                        null,
                        2,
                    ),
                },
            ],
        };
    },
};
