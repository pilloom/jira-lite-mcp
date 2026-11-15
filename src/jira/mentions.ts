import { resolveUser, type JiraResolvedUser } from './users.js';

import type { AdfNode } from './adf.js';

/**
 * Completa las menciones que `markdownToAdf` deja marcadas: nodos `mention`
 * con la referencia escrita —correo, nombre o accountId— en `text` y sin `id`.
 *
 * Recorre el payload entero, no un documento suelto, para que quien construye
 * varios campos de texto rico —descripción y textarea personalizados— lo haga
 * en una sola llamada. Cada referencia distinta se consulta una vez.
 *
 * Una referencia que no resuelve, o que designa a varias personas, rechaza la
 * escritura entera: un comentario publicado con «@Pedro» como texto plano
 * parece una mención y no avisa a nadie, que es el fallo que esto corrige.
 */
export async function resolveMentions<T>(payload: T): Promise<T> {
    const pending: AdfNode[] = [];

    collect(payload, pending);

    if (pending.length === 0) {
        return payload;
    }

    const references = [
        ...new Set(pending.map((node) => node.attrs!.text!)),
    ];

    const resolved = new Map<string, JiraResolvedUser>();

    await Promise.all(
        references.map(async (reference) => {
            try {
                resolved.set(reference, await resolveUser(reference));
            } catch (error) {
                const reason =
                    error instanceof Error ? error.message : String(error);

                throw new Error(`La mención @[${reference}] no se pudo resolver: ${reason}`);
            }
        }),
    );

    for (const node of pending) {
        const user = resolved.get(node.attrs!.text!)!;

        node.attrs = { id: user.accountId, text: `@${user.displayName}` };
    }

    return payload;
}

function collect(value: unknown, pending: AdfNode[]): void {
    if (Array.isArray(value)) {
        for (const item of value) {
            collect(item, pending);
        }

        return;
    }

    if (value === null || typeof value !== 'object') {
        return;
    }

    const node = value as AdfNode;

    if (
        node.type === 'mention' &&
        node.attrs?.id === undefined &&
        node.attrs?.text !== undefined
    ) {
        pending.push(node);
        return;
    }

    for (const child of Object.values(value)) {
        collect(child, pending);
    }
}
