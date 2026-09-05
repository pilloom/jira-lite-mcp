import { randomUUID } from 'node:crypto';

import type { AdfDocument, AdfMark, AdfNode } from './adf.js';

/**
 * Traduce markdown al formato con el que la API v3 escribe los campos de texto
 * rico. Sin esto no hay forma de crear desde el servidor una lista de tareas
 * —las casillas marcables del editor de Jira—: todo lo enviado acaba como
 * párrafos y solo la interfaz web puede darle estructura después.
 *
 * Cubre lo que aparece en un ticket escrito a mano: listas de tareas, listas
 * con viñetas y numeradas —anidadas por indentación—, encabezados, citas,
 * bloques de código, reglas, y en línea negrita, cursiva, tachado, código y
 * enlaces. La dirección contraria vive en `adf.ts`.
 */

type ListType = 'bulletList' | 'orderedList' | 'taskList';

interface MarkdownItem {
    /** Espacios a la izquierda del marcador: determinan el anidamiento. */
    indent: number;
    type: ListType;
    done: boolean;
    text: string;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*(\S+)?\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const ITEM = /^([ \t]*)(?:([-*+])|(\d+)[.)])[ \t]+(.*)$/;
const TASK = /^\[([ xX])\][ \t]+(.*)$/;

/**
 * Fragmentos con formato. Se prueban en este orden, de modo que `**` gana a
 * `*` y el código gana a todo lo demás: lo que va entre acentos graves se
 * envía tal cual.
 *
 * Los delimitadores exigen un carácter no blanco pegado a ellos, para que una
 * multiplicación —`2 * 3 * 4`— o un guion bajo dentro de un identificador no
 * se interpreten como énfasis.
 */
const INLINE = new RegExp(
    [
        '(`+)([^`]+)\\1',
        '\\*\\*(\\S(?:.*?\\S)?)\\*\\*',
        '__(\\S(?:.*?\\S)?)__',
        '\\*(\\S(?:[^*]*?\\S)?)\\*',
        '(?<![A-Za-z0-9])_(\\S(?:[^_]*?\\S)?)_(?![A-Za-z0-9])',
        '~~(\\S(?:.*?\\S)?)~~',
        '\\[([^\\]]*)\\]\\(([^)\\s]+)\\)',
    ].join('|'),
    'g',
);

function textNode(text: string, marks?: AdfMark[]): AdfNode {
    return marks ? { type: 'text', text, marks } : { type: 'text', text };
}

function inlineNodes(text: string): AdfNode[] {
    const nodes: AdfNode[] = [];

    let plainFrom = 0;

    const pushPlain = (until: number): void => {
        const plain = text.slice(plainFrom, until);

        if (plain.length > 0) {
            nodes.push(textNode(plain));
        }
    };

    for (const match of text.matchAll(INLINE)) {
        const [whole, , code, strongStars, strongBars, emStar, emBar, strike, linkText, href] =
            match;

        const at = match.index ?? 0;

        pushPlain(at);
        plainFrom = at + whole.length;

        if (code !== undefined) {
            nodes.push(textNode(code, [{ type: 'code' }]));
        } else if (strongStars ?? strongBars) {
            nodes.push(
                textNode((strongStars ?? strongBars)!, [{ type: 'strong' }]),
            );
        } else if (emStar ?? emBar) {
            nodes.push(textNode((emStar ?? emBar)!, [{ type: 'em' }]));
        } else if (strike !== undefined) {
            nodes.push(textNode(strike, [{ type: 'strike' }]));
        } else if (href !== undefined) {
            nodes.push(
                textNode(linkText || href, [
                    { type: 'link', attrs: { href } },
                ]),
            );
        }
    }

    pushPlain(text.length);

    return nodes;
}

function paragraph(text: string): AdfNode {
    const content = inlineNodes(text);

    return content.length > 0
        ? { type: 'paragraph', content }
        : { type: 'paragraph' };
}

function listNode(type: ListType): AdfNode {
    // Jira exige un identificador propio en cada nodo de una lista de tareas:
    // es la referencia con la que después marca y desmarca cada casilla.
    return type === 'taskList'
        ? { type, attrs: { localId: randomUUID() }, content: [] }
        : { type, content: [] };
}

function itemNode(item: MarkdownItem): AdfNode {
    if (item.type === 'taskList') {
        return {
            type: 'taskItem',
            attrs: {
                localId: randomUUID(),
                state: item.done ? 'DONE' : 'TODO',
            },
            content: inlineNodes(item.text),
        };
    }

    return { type: 'listItem', content: [paragraph(item.text)] };
}

/** Cuelga una sublista del último elemento de la lista que la contiene. */
function nest(parent: AdfNode, child: AdfNode): void {
    const items = parent.content ?? [];

    if (parent.type === 'taskList') {
        items.push(child);
        return;
    }

    const last = items[items.length - 1];

    if (last?.type === 'listItem') {
        (last.content ??= []).push(child);
        return;
    }

    items.push({ type: 'listItem', content: [paragraph(''), child] });
}

/**
 * Reconstruye la jerarquía a partir de la indentación. Un elemento más
 * indentado que el anterior abre una sublista; uno del mismo nivel pero de
 * otro tipo abre una lista hermana, porque markdown no admite mezclar
 * viñetas y numeración en la misma.
 */
function buildLists(items: MarkdownItem[]): AdfNode[] {
    const roots: AdfNode[] = [];
    const open: Array<{ indent: number; type: ListType; node: AdfNode }> = [];

    for (const item of items) {
        while (
            open.length > 0 &&
            item.indent < open[open.length - 1].indent
        ) {
            open.pop();
        }

        let current = open[open.length - 1];

        if (current && item.indent === current.indent && item.type !== current.type) {
            open.pop();
            current = open[open.length - 1];
        }

        if (!current || item.indent > current.indent) {
            const list = listNode(item.type);

            if (current) {
                nest(current.node, list);
            } else {
                roots.push(list);
            }

            open.push({ indent: item.indent, type: item.type, node: list });
            current = open[open.length - 1];
        }

        (current.node.content ??= []).push(itemNode(item));
    }

    return roots;
}

function toItem(match: RegExpExecArray): MarkdownItem {
    const [, indent, bullet, , rest] = match;

    const task = bullet ? TASK.exec(rest) : null;

    if (task) {
        return {
            indent: indent.length,
            type: 'taskList',
            done: task[1].toLowerCase() === 'x',
            text: task[2],
        };
    }

    return {
        indent: indent.length,
        type: bullet ? 'bulletList' : 'orderedList',
        done: false,
        text: rest,
    };
}

function parseBlocks(lines: string[]): AdfNode[] {
    const nodes: AdfNode[] = [];

    let index = 0;

    while (index < lines.length) {
        const line = lines[index];

        if (line.trim().length === 0) {
            index += 1;
            continue;
        }

        const fence = FENCE.exec(line);

        if (fence) {
            const code: string[] = [];

            index += 1;

            while (
                index < lines.length &&
                !new RegExp(`^ {0,3}${fence[1][0]}{3,}\\s*$`).test(lines[index])
            ) {
                code.push(lines[index]);
                index += 1;
            }

            // Sin línea de cierre el bloque llega hasta el final del texto.
            index += 1;

            nodes.push({
                type: 'codeBlock',
                ...(fence[2] && { attrs: { language: fence[2] } }),
                ...(code.length > 0 && {
                    content: [textNode(code.join('\n'))],
                }),
            });

            continue;
        }

        if (RULE.test(line)) {
            nodes.push({ type: 'rule' });
            index += 1;
            continue;
        }

        const heading = HEADING.exec(line);

        if (heading) {
            nodes.push({
                type: 'heading',
                attrs: { level: heading[1].length },
                content: inlineNodes(heading[2]),
            });
            index += 1;
            continue;
        }

        if (QUOTE.test(line)) {
            const quoted: string[] = [];

            while (index < lines.length) {
                const inner = QUOTE.exec(lines[index]);

                if (!inner) {
                    break;
                }

                quoted.push(inner[1]);
                index += 1;
            }

            nodes.push({ type: 'blockquote', content: parseBlocks(quoted) });
            continue;
        }

        if (ITEM.test(line)) {
            const items: MarkdownItem[] = [];

            while (index < lines.length) {
                const match = ITEM.exec(lines[index]);

                if (match) {
                    items.push(toItem(match));
                    index += 1;
                    continue;
                }

                // Una línea indentada que no abre elemento continúa el
                // anterior; en markdown pertenece al mismo párrafo.
                const continuation = /^[ \t]+(\S.*)$/.exec(lines[index]);

                if (!continuation || items.length === 0) {
                    break;
                }

                items[items.length - 1].text += ` ${continuation[1]}`;
                index += 1;
            }

            nodes.push(...buildLists(items));
            continue;
        }

        // Cada línea suelta es un párrafo. Unirlas como hace markdown estándar
        // borraría los saltos con los que se escribió el texto, que es
        // justamente lo que se ve en Jira.
        nodes.push(paragraph(line));
        index += 1;
    }

    return nodes;
}

/**
 * Convierte markdown —o texto plano, que es markdown sin marcas— en un
 * documento ADF. Un texto vacío produce un documento con un párrafo vacío:
 * la API rechaza un documento sin contenido.
 */
export function markdownToAdf(text: string): AdfDocument {
    const content = parseBlocks(text.split('\n'));

    return {
        type: 'doc',
        version: 1,
        content: content.length > 0 ? content : [{ type: 'paragraph' }],
    };
}
