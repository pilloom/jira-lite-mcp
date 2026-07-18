import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { pingTool } from './ping.js';
import { issueGetTool } from './issue-get.js';
import { searchTool } from './search.js';
import { issueFieldsTool } from './issue-fields.js';
import { createIssueTool } from './create-issue.js';
import { transitionIssueTool } from './transition-issue.js';

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
}