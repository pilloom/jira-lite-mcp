import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { pingTool } from './ping.js';
import { issueGetTool } from './issue-get.js';
import { searchTool } from './search.js';

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
}
