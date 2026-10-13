import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { writeFile } from 'node:fs/promises';

const evidence = { evidence_id: 'ev_' + 'a'.repeat(64), operation: 'capture_browser_scenario', normalized_result: {
  steps: [{ step_id: 'observe', status: 'completed', elapsed_ms: 1, after_url: { url: 'https://example.invalid/' }, artifacts: { accessibility: { state: 'captured', value: { text: '- document: learning fixture' } } } }],
  duration_ms: 1, completeness: { status: 'complete' }, limitations: [], events: { dropped: 0, items: [
    { kind: 'request', transaction_id: 'req1', method: 'GET', url: { url: 'https://example.invalid/api/quote?acs_token=fixture-secret&code=EXAMPLE' }, header_names: ['Acs-Token'] },
    { kind: 'response', transaction_id: 'req1', status: 200 },
    { kind: 'websocket-opened', url: { url: 'wss://example.invalid/?acs_token=fixture-secret' } },
  ] } } };
const server = new Server({ name: 'learning-rea-stub', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: ['capture_browser_scenario', 'export_evidence_bundle', 'export_web_scripts'].map(name => ({ name, inputSchema: { type: 'object', additionalProperties: true } })) }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  if (request.params.name === 'capture_browser_scenario') return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: 'resource_constraint', message: 'response budget', details: { resource: 'transport' } } }) }] };
  if (request.params.name === 'export_evidence_bundle') { await writeFile(request.params.arguments.path, JSON.stringify({ records: [evidence] })); return { content: [{ type: 'text', text: JSON.stringify({ result: { records: 1 } }) }] }; }
  return { content: [{ type: 'text', text: JSON.stringify({ normalized_result: { scripts: [], analysis_input: null } }) }] };
});
process.stdin.on('end', () => { void server.close(); });
await server.connect(new StdioServerTransport());
