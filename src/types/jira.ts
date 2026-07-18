export interface JiraIssue {
    key: string;
    summary: string;
    status: string;
    assignee: string | null;
    description: string | null;
}

export interface JiraSearchResult {
    total: number;
    issues: JiraIssue[];
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