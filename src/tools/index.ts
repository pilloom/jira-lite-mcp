import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { pingTool } from './ping.js';
import { issueGetTool } from './issue-get.js';
import { searchTool } from './search.js';
import { issueFieldsTool } from './issue-fields.js';
import { createIssueTool } from './create-issue.js';
import { transitionIssueTool } from './transition-issue.js';
import { linkIssuesTool } from './link-issues.js';
import { updateIssueTool } from './update-issue.js';
import { myWorkTool } from './my-work.js';
import { projectSummaryTool } from './project-summary.js';
import { explainIssueTool } from './explain-issue.js';
import { addCommentTool } from './add-comment.js';
import { addWorklogTool } from './add-worklog.js';
import { getWorklogTool } from './get-worklog.js';
import { deleteTool } from './delete.js';

export function registerTools(server: McpServer) {
    server.registerTool(
        pingTool.name,
        {
            description: pingTool.description,
            inputSchema: pingTool.inputSchema,
        },
        async () => pingTool.handler(),
    );

    server.registerTool(
        issueGetTool.name,
        {
            description: issueGetTool.description,
            inputSchema: issueGetTool.inputSchema,
        },
        async (args) => issueGetTool.handler(args),
    );

    server.registerTool(

        searchTool.name,
        {
            description: searchTool.description,
            inputSchema: searchTool.inputSchema,
        },
        async (args) => searchTool.handler(args),

    );

    server.registerTool(
        issueFieldsTool.name,
        {
            description: issueFieldsTool.description,
            inputSchema: issueFieldsTool.inputSchema,
        },
        async (args) => issueFieldsTool.handler(args),
    );

    server.registerTool(
        createIssueTool.name,
        {
            description: createIssueTool.description,
            inputSchema: createIssueTool.inputSchema,
        },
        async (args) => createIssueTool.handler(args),
    );

    server.registerTool(
        transitionIssueTool.name,
        {
            description: transitionIssueTool.description,
            inputSchema: transitionIssueTool.inputSchema,
        },
        async (args) => transitionIssueTool.handler(args),
    );

    server.registerTool(
        linkIssuesTool.name,
        {
            description: linkIssuesTool.description,
            inputSchema: linkIssuesTool.inputSchema,
        },
        async (args) => linkIssuesTool.handler(args),
    );

    server.registerTool(
        updateIssueTool.name,
        {
            description: updateIssueTool.description,
            inputSchema: updateIssueTool.inputSchema,
        },
        async (args) => updateIssueTool.handler(args),
    );

    server.registerTool(
        myWorkTool.name,
        {
            description: myWorkTool.description,
            inputSchema: myWorkTool.inputSchema,
        },
        async (args) => myWorkTool.handler(args),
    );

    server.registerTool(
        projectSummaryTool.name,
        {
            description: projectSummaryTool.description,
            inputSchema: projectSummaryTool.inputSchema,
        },
        async (args) => projectSummaryTool.handler(args),
    );

    server.registerTool(
        explainIssueTool.name,
        {
            description: explainIssueTool.description,
            inputSchema: explainIssueTool.inputSchema,
        },
        async (args) => explainIssueTool.handler(args),
    );

    server.registerTool(
        addCommentTool.name,
        {
            description: addCommentTool.description,
            inputSchema: addCommentTool.inputSchema,
        },
        async (args) => addCommentTool.handler(args),
    );

    server.registerTool(
        addWorklogTool.name,
        {
            description: addWorklogTool.description,
            inputSchema: addWorklogTool.inputSchema,
        },
        async (args) => addWorklogTool.handler(args),
    );

    server.registerTool(
        getWorklogTool.name,
        {
            description: getWorklogTool.description,
            inputSchema: getWorklogTool.inputSchema,
        },
        async (args) => getWorklogTool.handler(args),
    );

    server.registerTool(
        deleteTool.name,
        {
            description: deleteTool.description,
            inputSchema: deleteTool.inputSchema,
        },
        async (args) => deleteTool.handler(args),
    );
}