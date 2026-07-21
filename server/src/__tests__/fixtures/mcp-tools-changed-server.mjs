import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

let extraEnabled = false;
const extendedTools = process.env.MCP_EXTENDED_TOOLS === '1';
const extendedReadTools = [
  ['list_values', 'List controlled values', {}],
  ['search_values', 'Search controlled values', { query: { type: 'string', description: 'Search query' } }],
  ['get_status', 'Get controlled service status', {}],
  ['get_metadata', 'Get controlled metadata', { key: { type: 'string', description: 'Metadata key' } }],
  ['resolve_reference', 'Resolve a controlled reference', { reference: { type: 'string', description: 'Reference id' } }],
  ['inspect_history', 'Inspect controlled value history', { key: { type: 'string', description: 'Value key' } }],
];
const server = new Server(
  { name: 'controlled-tools-changed-server', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true } } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'read_value',
      description: 'Read a controlled value',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string', description: 'Value key' } },
        required: ['key'],
      },
    },
    {
      name: 'enable_extra_tool',
      description: 'Enable a second controlled test tool',
      inputSchema: { type: 'object', properties: {} },
    },
    ...(extendedTools ? extendedReadTools.map(([name, description, properties]) => ({
      name,
      description,
      inputSchema: { type: 'object', properties },
    })) : []),
    ...(extraEnabled ? [{
      name: 'read_extra',
      description: 'Read the newly enabled controlled value',
      inputSchema: { type: 'object', properties: {} },
    }] : []),
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'enable_extra_tool') {
    extraEnabled = true;
    await server.sendToolListChanged();
    return { content: [{ type: 'text', text: 'extra tool enabled' }] };
  }
  if (request.params.name === 'read_value') {
    return { content: [{ type: 'text', text: `value:${String(request.params.arguments?.key ?? '')}` }] };
  }
  if (request.params.name === 'read_extra' && extraEnabled) {
    return { content: [{ type: 'text', text: 'extra value' }] };
  }
  return { isError: true, content: [{ type: 'text', text: 'tool unavailable' }] };
});

await server.connect(new StdioServerTransport());
