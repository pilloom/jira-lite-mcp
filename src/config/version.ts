import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface ServerVersion {
    name: string;
    version: string;
    /** Fecha de compilación del código en ejecución. */
    built: string;
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

/**
 * Identifica el código que se está ejecutando.
 *
 * Un cliente MCP arranca el servidor al abrir la sesión y mantiene ese proceso
 * mientras dura, de modo que tras recompilar sigue sirviendo el código
 * anterior. Sin esta información no hay forma de distinguir una capacidad no
 * implementada de una no desplegada, que son diagnósticos opuestos.
 *
 * La fecha de compilación es la señal fiable: la versión declarada solo cambia
 * cuando alguien se acuerda de subirla.
 */
export function getServerVersion(): ServerVersion {
    const packagePath = resolve(moduleDirectory, '../../package.json');

    const manifest = JSON.parse(readFileSync(packagePath, 'utf8')) as {
        name: string;
        version: string;
    };

    return {
        name: manifest.name,
        version: manifest.version,
        built: statSync(fileURLToPath(import.meta.url)).mtime.toISOString(),
    };
}
