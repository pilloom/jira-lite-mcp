/**
 * Prepara un nombre para compararlo con los que devuelve Jira. Los nombres
 * visibles dependen del idioma del sitio, así que se comparan ignorando
 * mayúsculas, espacios sobrantes y acentos.
 */
export function normalizeName(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
}
