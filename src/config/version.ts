import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface StaleCode {
    /** Versión declarada en el código compilado que hay en disco. */
    version: string;
    /** Fecha de ese código, posterior a la del que este proceso cargó. */
    built: string;
}

interface ServerVersion {
    name: string;
    /** Versión declarada cuando arrancó este proceso. */
    version: string;
    /** Fecha del código que este proceso cargó. */
    built: string;
    /** Arranque de este proceso. */
    started: string;
    /**
     * Resultado de la comprobación, dicho siempre: al día, por detrás del
     * disco, o no comprobable. Un campo ausente se puede leer como cualquiera
     * de los tres, que es el error que esta herramienta existe para no
     * cometer.
     */
    note: string;
    /** Presente solo si hay código compilado que este proceso no ha cargado. */
    stale?: StaleCode;
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url));

/** Raíz del código en ejecución: `dist/` compilado, o `src/` en modo watch. */
const codeRoot = resolve(moduleDirectory, '..');

const packagePath = resolve(moduleDirectory, '../../package.json');

function readDeclaredVersion(): { name: string; version: string } {
    const manifest = JSON.parse(readFileSync(packagePath, 'utf8')) as {
        name: string;
        version: string;
    };

    return { name: manifest.name, version: manifest.version };
}

/**
 * Fecha del fichero de código más reciente.
 *
 * Se mira el árbol entero y no un fichero concreto: un arreglo puede tocar
 * cualquier módulo, y la fecha de uno solo no dice nada de los demás.
 */
function newestCodeTime(directory: string): number {
    let newest = 0;

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);

        if (entry.isDirectory()) {
            newest = Math.max(newest, newestCodeTime(path));
            continue;
        }

        if (entry.name.endsWith('.js') || entry.name.endsWith('.ts')) {
            newest = Math.max(newest, statSync(path).mtimeMs);
        }
    }

    return newest;
}

// Se capturan al cargar el módulo, que es cuando se carga el resto del código:
// a partir de aquí el disco puede cambiar, pero esto ya no.
const loadedCode = readDeclaredVersion();

/**
 * Fecha del código que se cargó, o `null` si no se pudo medir. Medirla aquí
 * es lo que la ata al código en ejecución: leerla al responder daría la del
 * disco, que es precisamente lo que no se quiere saber.
 */
const loadedBuilt = (() => {
    try {
        return newestCodeTime(codeRoot);
    } catch {
        // Se resuelve al responder, que es donde se puede explicar.
        return null;
    }
})();

const processStart = Date.now() - process.uptime() * 1000;

/**
 * Identifica el código que **este proceso** está ejecutando.
 *
 * Un cliente MCP arranca el servidor al abrir la sesión y mantiene ese proceso
 * mientras dura, de modo que tras recompilar sigue sirviendo el código
 * anterior. Sin esta información no hay forma de distinguir una capacidad no
 * implementada de una no desplegada, que son diagnósticos opuestos.
 *
 * Por eso lo que se informa no se lee del disco en el momento de preguntarlo:
 * el disco cuenta lo que hay compilado, no lo que está cargado, y los dos se
 * separan justo cuando importa saberlo. La versión y la fecha son las de
 * cuando arrancó este proceso; el disco se consulta solo para avisar de que ha
 * quedado por detrás.
 */
export function getServerVersion(): ServerVersion {
    const base: Omit<ServerVersion, 'note'> = {
        name: loadedCode.name,
        version: loadedCode.version,
        built: new Date(loadedBuilt ?? processStart).toISOString(),
        started: new Date(processStart).toISOString(),
    };

    if (loadedBuilt === null) {
        return {
            ...base,
            note: 'No se pudo leer la fecha del código al arrancar, así que "built" es la hora de arranque del proceso y no se puede comprobar si hay código más reciente en disco.',
        };
    }

    try {
        const newest = newestCodeTime(codeRoot);

        if (newest <= loadedBuilt) {
            return {
                ...base,
                note: 'Este proceso tiene cargado el código más reciente que hay compilado en disco.',
            };
        }

        return {
            ...base,
            note: 'Hay código compilado después del que cargó este proceso, que por tanto no lo ejecuta: lo que responden las herramientas es el código anterior, aunque el disco diga otra cosa. Hay que reiniciar la sesión de Claude Code.',
            stale: {
                version: readDeclaredVersion().version,
                built: new Date(newest).toISOString(),
            },
        };
    } catch (error) {
        // No poder comprobarlo se dice. Callarlo equivaldría a afirmar que el
        // código está al día, que es la respuesta que no se puede sostener.
        return {
            ...base,
            note: `No se ha podido comprobar si hay código más reciente en disco: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}
