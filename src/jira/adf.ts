/**
 * Atlassian Document Format: el formato con el que la API v3 representa los
 * campos de texto rico (descripciones, comentarios). Este módulo aísla su
 * serialización para que el resto del código trabaje con texto plano.
 */

interface AdfTextNode {
    type: 'text';
    text: string;
}

interface AdfParagraphNode {
    type: 'paragraph';
    content?: AdfTextNode[];
}

export interface AdfDocument {
    type: 'doc';
    version: 1;
    content: AdfParagraphNode[];
}

interface AdfNode {
    type?: string;
    text?: string;
    content?: AdfNode[];
    attrs?: {
        text?: string;
        shortName?: string;
        url?: string;
    };
}

/**
 * Nodos cuyos hijos son bloques independientes y por tanto se separan con un
 * salto de línea. En el resto —párrafos, encabezados— los hijos son fragmentos
 * de una misma línea y se concatenan sin separador.
 */
const BLOCK_CONTAINERS = new Set([
    'doc',
    'blockquote',
    'listItem',
    'taskList',
    'table',
    'tableRow',
    'tableCell',
    'tableHeader',
    'panel',
]);

function nodeToText(node: AdfNode): string {
    switch (node.type) {
        case 'text':
            return node.text ?? '';
        case 'hardBreak':
            return '\n';
        case 'rule':
            return '---';
        case 'mention':
        case 'emoji':
            return node.attrs?.text ?? node.attrs?.shortName ?? '';
        case 'inlineCard':
            return node.attrs?.url ?? '';
        default:
            break;
    }

    const children = (node.content ?? []).map(nodeToText);

    if (node.type === 'bulletList') {
        return children.map((child) => `- ${child}`).join('\n');
    }

    if (node.type === 'orderedList') {
        return children
            .map((child, index) => `${index + 1}. ${child}`)
            .join('\n');
    }

    return children.join(BLOCK_CONTAINERS.has(node.type ?? '') ? '\n' : '');
}

/**
 * Convierte un documento ADF en texto legible. Acepta también un string —los
 * campos de texto plano llegan así— y valores ausentes, de modo que quien
 * llama no necesita saber de qué tipo es el campo que está leyendo.
 */
export function adfToText(value: unknown): string | null {
    if (value === null || value === undefined) {
        return null;
    }

    if (typeof value === 'string') {
        return value;
    }

    if (typeof value !== 'object') {
        return String(value);
    }

    return nodeToText(value as AdfNode);
}

/**
 * Convierte texto plano en un documento ADF. Cada línea es un párrafo, de modo
 * que los saltos de línea del texto original se conservan al mostrarse en Jira.
 */
export function textToAdf(text: string): AdfDocument {
    const content: AdfParagraphNode[] = text.split('\n').map((line) =>
        line.length > 0
            ? { type: 'paragraph', content: [{ type: 'text', text: line }] }
            : { type: 'paragraph' },
    );

    return {
        type: 'doc',
        version: 1,
        content,
    };
}
