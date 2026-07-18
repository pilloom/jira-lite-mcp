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
