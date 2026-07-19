export interface JiraIssue {
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
    issues: JiraIssue[];
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
    assignee?: string;
    priority?: string;
    labels?: string[];
    /** Campos personalizados indexados por nombre visible o por identificador. */
    customFields?: Record<string, unknown>;
}

export interface JiraCreatedIssue {
    key: string;
    url: string;
}

export interface JiraUpdateIssueInput {
    issueKey: string;
    summary?: string;
    description?: string;
    assignee?: string;
    priority?: string;
    labels?: string[];
    /** Campos personalizados indexados por nombre visible o por identificador. */
    customFields?: Record<string, unknown>;
}

export interface JiraUpdatedIssue {
    key: string;
    /** Identificadores de los campos efectivamente enviados. */
    updated: string[];
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