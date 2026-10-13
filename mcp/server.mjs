import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AnalysisService } from '../lib/service.mjs';
import { VERSION } from '../lib/config.mjs';
import { callTool, tools } from './tools.mjs';
import { redact } from '../lib/projects.mjs';

const service = await AnalysisService.create();
const server = new Server({ name: 'software-analysis', version: VERSION }, { capabilities: { tools: {} },
  instructions: 'Manage local software investigations and evidence. REA analysis tools are exposed by the separate rea_analysis server. Static analysis does not establish runtime behavior.' });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  try {
    const result = await callTool(service, request.params.name, request.params.arguments || {}, extra.signal);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result };
  } catch (error) {
    return { content: [{ type: 'text', text: redact(error.message) }], isError: true };
  }
});
let ending = false;
async function shutdown() {
  if (ending) return;
  ending = true;
  await service.shutdown();
  await server.close();
}
process.stdin.on('end', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
server.onerror = error => process.stderr.write(`Software analysis MCP: ${error.message}\n`);
await server.connect(new StdioServerTransport());
