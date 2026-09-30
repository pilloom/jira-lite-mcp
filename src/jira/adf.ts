/**
 * Atlassian Document Format: el formato con el que la API v3 representa los
 * campos de texto rico (descripciones, comentarios, textarea personalizados).
 *
 * Este módulo lo traduce a markdown en lugar de aplanarlo a texto corrido: la
 * estructura —listas de tareas con su estado, encabezados, énfasis, código— es
 * información del campo, y perderla al leer hace indistinguible una lista de
 * criterios de un párrafo suelto. La dirección contraria vive en `markdown.ts`.
 */

export interface AdfMark {
    type: string;
    attrs?: {
        href?: string;
    };
}

export interface AdfNode {
    type?: string;
    text?: string;
    marks?: AdfMark[];
    content?: AdfNode[];
    attrs?: {
        text?: string;
        shortName?: string;
        url?: string;
        href?: string;
        level?: number;
        language?: string;
        state?: string;
        localId?: string;
        timestamp?: string;
        isNumberColumnEnabled?: boolean;
        layout?: string;
        order?: number;
    };
}

export interface AdfDocument {
    type: 'doc';
    version: 1;
    content: AdfNode[];
}

const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList']);

/**
 * Nodos que ocupan líneas propias. Sirve para decidir si un nodo desconocido
 * es un contenedor de bloques —sus hijos se separan— o un fragmento en línea.
 */
const BLOCK_TYPES = new Set([
    'paragraph',
    'heading',
    'codeBlock',
    'rule',
    'blockquote',
    'panel',
    'table',
    'mediaSingle',
    'mediaGroup',
    'expand',
    'nestedExpand',
    ...LIST_TYPES,
]);

function isList(node: AdfNode): boolean {
    return LIST_TYPES.has(node.type ?? '');
}

/**
 * Envuelve un fragmento con la sintaxis markdown de sus marcas, de dentro
 * hacia fuera. Un fragmento en blanco se deja intacto: `** **` no es énfasis
 * en markdown, solo dos asteriscos sueltos.
 */
function applyMarks(text: string, marks: AdfMark[] = []): string {
    if (text.trim().length === 0) {
        return text;
    }

    const has = (type: string): boolean =>
        marks.some((mark) => mark.type === type);

    let result = text;

    if (has('code')) {
        result = `\`${result}\``;
    }

    if (has('strong')) {
        result = `**${result}**`;
    }

    if (has('em')) {
        result = `*${result}*`;
    }

    if (has('strike')) {
        result = `~~${result}~~`;
    }

    const link = marks.find((mark) => mark.type === 'link');

    if (link?.attrs?.href) {
        result = `[${result}](${link.attrs.href})`;
    }

    return result;
}

/** Las fechas viajan como milisegundos en una cadena. */
function dateToText(timestamp: string | undefined): string {
    const milliseconds = Number(timestamp);

    if (!timestamp || Number.isNaN(milliseconds)) {
        return '';
    }

    return new Date(milliseconds).toISOString().slice(0, 10);
}

function nodeToInline(node: AdfNode): string {
    switch (node.type) {
        case 'text':
            return applyMarks(node.text ?? '', node.marks);
        case 'hardBreak':
            return '\n';
        case 'mention':
        case 'emoji':
        case 'status':
            return node.attrs?.text ?? node.attrs?.shortName ?? '';
        case 'inlineCard':
            return node.attrs?.url ?? node.attrs?.href ?? '';
        case 'date':
            return dateToText(node.attrs?.timestamp);
        default:
            return inlineToMarkdown(node.content);
    }
}

function inlineToMarkdown(nodes: AdfNode[] = []): string {
    return nodes.map(nodeToInline).join('');
}

function prefixLines(text: string, prefix: string): string {
    return text
        .split('\n')
        .map((line) => `${prefix}${line}`.trimEnd())
        .join('\n');
}

function markerFor(list: AdfNode, index: number, item: AdfNode): string {
    if (list.type === 'orderedList') {
        return `${(list.attrs?.order ?? 1) + index}. `;
    }

    if (item.type === 'taskItem') {
        return item.attrs?.state === 'DONE' ? '- [x] ' : '- [ ] ';
    }

    return '- ';
}

/**
 * Cuerpo de un elemento de lista. El primer bloque va en la misma línea que el
 * marcador y los siguientes se alinean bajo él, que es como markdown reconoce
 * que siguen perteneciendo al mismo elemento.
 */
function itemToMarkdown(item: AdfNode, depth: number, offset: number): string {
    if (item.type === 'taskItem') {
        return inlineToMarkdown(item.content);
    }

    const parts: string[] = [];

    for (const block of item.content ?? []) {
        if (isList(block)) {
            parts.push(`\n${listToMarkdown(block, depth + 1)}`);
            continue;
        }

        const text = blockToMarkdown(block, depth);

        parts.push(
            parts.length === 0
                ? text
                : `\n${prefixLines(text, ' '.repeat(offset))}`,
        );
    }

    return parts.join('');
}

function listToMarkdown(list: AdfNode, depth: number): string {
    const padding = '  '.repeat(depth);

    const lines = (list.content ?? []).map((item, index) => {
        // Una lista de tareas anidada cuelga de la lista, no del elemento.
        if (isList(item)) {
            return listToMarkdown(item, depth + 1);
        }

        const marker = markerFor(list, index, item);

        const body = itemToMarkdown(
            item,
            depth,
            padding.length + marker.length,
        );

        return `${padding}${marker}${body}`;
    });

    return lines.join('\n');
}

function cellsToMarkdown(row: AdfNode): string[] {
    return (row.content ?? []).map((cell) =>
        blocksToMarkdown(cell.content)
            .replace(/\|/g, '\\|')
            .replace(/\s*\n+\s*/g, ' ')
            .trim(),
    );
}

function tableToMarkdown(table: AdfNode): string {
    const rows = (table.content ?? [])
        .filter((row) => row.type === 'tableRow')
        .map(cellsToMarkdown);

    if (rows.length === 0) {
        return '';
    }

    const columns = Math.max(...rows.map((row) => row.length));

    const line = (values: string[]): string => {
        const padded = [
            ...values,
            ...Array(columns - values.length).fill(''),
        ];

        return `| ${padded.join(' | ')} |`;
    };

    const [header, ...body] = rows;

    return [
        line(header),
        line(Array(columns).fill('---')),
        ...body.map(line),
    ].join('\n');
}

function blockToMarkdown(node: AdfNode, depth: number): string {
    switch (node.type) {
        case 'paragraph':
            return inlineToMarkdown(node.content);
        case 'heading': {
            const level = Math.min(Math.max(node.attrs?.level ?? 1, 1), 6);

            return `${'#'.repeat(level)} ${inlineToMarkdown(node.content)}`;
        }
        case 'codeBlock': {
            const code = (node.content ?? [])
                .map((child) => child.text ?? '')
                .join('');

            return `\`\`\`${node.attrs?.language ?? ''}\n${code}\n\`\`\``;
        }
        case 'rule':
            return '---';
        // Un panel es un aviso destacado; markdown no tiene nada más cercano
        // que la cita, que al menos conserva que el bloque va aparte.
        case 'blockquote':
        case 'panel':
            return prefixLines(blocksToMarkdown(node.content), '> ');
        case 'table':
            return tableToMarkdown(node);
        case 'bulletList':
        case 'orderedList':
        case 'taskList':
            return listToMarkdown(node, depth);
        default:
            break;
    }

    const children = node.content ?? [];

    return children.some((child) => BLOCK_TYPES.has(child.type ?? ''))
        ? blocksToMarkdown(children)
        : nodeToInline(node);
}

function blocksToMarkdown(nodes: AdfNode[] = []): string {
    return nodes
        .map((node) => blockToMarkdown(node, 0))
        .filter((block) => block.length > 0)
        .join('\n\n');
}

/**
 * Distingue un documento ADF de cualquier otro objeto. Aplanar algo que no lo
 * es produce una cadena vacía, indistinguible de un campo realmente vacío.
 */
export function isAdfDocument(value: unknown): boolean {
    if (value === null || typeof value !== 'object') {
        return false;
    }

    const node = value as AdfNode;

    return node.type === 'doc' && Array.isArray(node.content);
}

/**
 * Convierte un documento ADF en markdown. Acepta también un string —los campos
 * de texto plano llegan así— y valores ausentes, de modo que quien llama no
 * necesita saber de qué tipo es el campo que está leyendo.
 */
export function adfToMarkdown(value: unknown): string | null {
    if (value === null || value === undefined) {
        return null;
    }

    if (typeof value === 'string') {
        return value;
    }

    if (typeof value !== 'object') {
        return String(value);
    }

    const node = value as AdfNode;

    return node.type === 'doc'
        ? blocksToMarkdown(node.content)
        : blockToMarkdown(node, 0);
}
