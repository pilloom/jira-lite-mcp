import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { getServerVersion } from './config/version.js';
import { registerTools } from './tools/index.js';

// La versión se toma del manifiesto para que no haya dos declaradas.
const { name, version } = getServerVersion();

const server = new McpServer({ name, version });

registerTools(server);

const transport = new StdioServerTransport();

await server.connect(transport);