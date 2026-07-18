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
