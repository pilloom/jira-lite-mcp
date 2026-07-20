export interface JiraIssue {
    key: string;
    url: string;
    summary: string;
    type: string;
    status: string;
    priority: string | null;
    assignee: string | null;
    parent: { key: string; summary: string } | null;
    labels: string[];
    created: string;
    updated: string;
    originalEstimate: string | null;
    timeSpent: string | null;
    description: string | null;
    customFields?: Record<string, unknown>;
}

/** Forma reducida que devuelven las búsquedas, sin los campos de detalle. */
export interface JiraIssueSummary {
    key: string;
    summary: string;
    status: string;
    assignee: string | null;
    description: string | null;
}

export interface JiraSearchResult {
    /** Issues devueltos en esta página, no el total de coincidencias. */
    count: number;
    /** Hay más resultados de los que caben en el límite pedido. */
    hasMore: boolean;
    /** Motivo probable de un resultado vacío, cuando se detecta uno. */
    warning?: string;
    issues: JiraIssueSummary[];
}

export interface JiraUser {
    accountId: string;
    displayName: string;
    email: string | null;
}

export interface JiraWorkItem {
    key: string;
    summary: string;
    type: string;
    status: string;
    priority: string | null;
    /** Fecha de la última actualización, sin hora. */
    updated: string;
}

export interface JiraMyWorkResult {
    user: string;
    count: number;
    hasMore: boolean;
    issues: JiraWorkItem[];
}

export interface JiraCommentResult {
    key: string;
    id: string;
    created: string;
}

export interface JiraWorklogEntry {
    id: string;
    author: string;
    timeSpent: string;
    timeSpentSeconds: number;
    started: string;
    comment: string | null;
}

export interface JiraWorklogList {
    key: string;
    originalEstimate: string | null;
    /** Total registrado, tal como lo expresa Jira según la jornada del sitio. */
    totalSpent: string | null;
    totalSpentSeconds: number;
    count: number;
    worklogs: JiraWorklogEntry[];
}

export type JiraDeletableType = 'comment' | 'worklog' | 'link';

export interface JiraDeleteResult {
    deleted: JiraDeletableType;
    id: string;
    issueKey?: string;
}

export interface JiraWorklogResult {
    key: string;
    id: string;
    /** Cómo ha interpretado Jira el tiempo enviado. */
    timeSpent: string;
    timeSpentSeconds: number;
    started: string;
    /** Equivalencia real cuando el tiempo se expresó en días. */
    note?: string;
}

export interface JiraSubtask {
    key: string;
    summary: string;
    status: string;
}

export interface JiraLinkedIssue extends JiraSubtask {
    /** Cómo se lee la relación desde este issue: «blocks», «relates to». */
    relation: string;
    /** Identificador del enlace, necesario para eliminarlo. */
    linkId: string;
}

export interface JiraIssueComment {
    /** Necesario para eliminar el comentario. */
    id: string;
    author: string;
    created: string;
    body: string;
}

export interface JiraIssueContext {
    key: string;
    summary: string;
    type: string;
    status: string;
    priority: string | null;
    assignee: string | null;
    reporter: string | null;
    created: string;
    updated: string;
    labels: string[];
    parent: JiraSubtask | null;
    description: string | null;
    subtasks: JiraSubtask[];
    links: JiraLinkedIssue[];
    /** Solo los más recientes; `totalComments` indica cuántos hay. */
    comments: JiraIssueComment[];
    totalComments: number;
    /** Estados a los que se puede mover el issue ahora mismo. */
    availableTransitions: string[];
    customFields?: Record<string, unknown>;
}

export interface JiraStaleIssue {
    key: string;
    summary: string;
    status: string;
    daysSinceUpdate: number;
}

export interface JiraProjectSummary {
    project: string;
    /** Issues abiertos considerados; parcial si `truncated` es cierto. */
    openIssues: number;
    truncated: boolean;
    byStatus: Record<string, number>;
    byType: Record<string, number>;
    byPriority: Record<string, number>;
    unassigned: number;
    stale: {
        days: number;
        count: number;
        oldest: JiraStaleIssue[];
    };
}

export interface JiraIssueType {
    id: string;
    name: string;
    subtask: boolean;
}

export interface JiraAllowedValue {
    id: string | null;
    name: string;
}

export interface JiraFieldSpec {
    id: string;
    name: string;
    required: boolean;
    type: string;
    /**
     * Variante del campo personalizado (textarea, textfield, float, select...).
     * `type` no basta para saber cómo serializar: summary, description y un
     * custom field de texto declaran los tres `string`, pero solo unos aceptan
     * texto plano y otros exigen un documento ADF.
     */
    custom?: string;
    allowedValues?: JiraAllowedValue[];
}

export interface JiraIssueTypesResult {
    project: string;
    issueTypes: JiraIssueType[];
}

export interface JiraIssueFieldsResult {
    project: string;
    issueType: string;
    fields: JiraFieldSpec[];
}

export interface JiraCreateIssueInput {
    project: string;
    issueType: string;
    summary: string;
    description?: string;
    parent?: string;
    /** Correo, nombre visible o identificador de cuenta. */
    assignee?: string;
    priority?: string;
    labels?: string[];
    /** Estimación inicial en el formato de Jira: 30m, 1h 30m, 8h. */
    originalEstimate?: string;
    /** Observadores: correos, nombres visibles o identificadores de cuenta. */
    watchers?: string[];
    /** Valida el payload y devuelve lo que se enviaría, sin crear nada. */
    dryRun?: boolean;
    /** Campos personalizados indexados por nombre visible o por identificador. */
    customFields?: Record<string, unknown>;
}

export interface JiraCreatedIssue {
    key: string | null;
    url: string | null;
    /** Identificadores de los campos efectivamente enviados. */
    applied: string[];
    dryRun?: boolean;
    /** Payload que se enviaría; solo en una validación sin crear. */
    fields?: Record<string, unknown>;
    /** Estimación tal como quedó registrada, para poder contrastarla. */
    timetracking?: {
        originalEstimate: string | null;
        originalEstimateSeconds: number | null;
    };
    watchers?: string[];
}

export interface JiraUpdateIssueInput {
    issueKey: string;
    summary?: string;
    description?: string;
    /** Correo, nombre visible o identificador de cuenta. */
    assignee?: string;
    priority?: string;
    labels?: string[];
    /** Estimación en el formato de Jira: 30m, 1h 30m, 8h. */
    originalEstimate?: string;
    /** Observadores a añadir: correos, nombres o identificadores de cuenta. */
    watchers?: string[];
    /** Campos personalizados indexados por nombre visible o por identificador. */
    customFields?: Record<string, unknown>;
}

export interface JiraUpdatedIssue {
    key: string;
    /** Identificadores de los campos efectivamente enviados. */
    updated: string[];
    watchers?: string[];
}

export interface JiraTransition {
    id: string;
    name: string;
    /** Estado al que lleva la transición. */
    to: string;
}

export interface JiraTransitionResult {
    key: string;
    status: string;
    transition: string;
    /** Presente si se pidió comentario: el cambio de estado ya se aplicó. */
    commentPublished?: boolean;
    commentError?: string;
}

export interface JiraLinkType {
    name: string;
    /** Cómo se lee la relación desde el issue de origen: «blocks». */
    outward: string;
    /** Cómo se lee desde el de destino: «is blocked by». */
    inward: string;
}

export interface JiraLinkResult {
    from: string;
    relation: string;
    to: string;
}