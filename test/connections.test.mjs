import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkEnvironment } from '../lib/environment.mjs';
import { workspace } from './helpers.mjs';

async function stubRea(root) {
  const directory = path.join(root, 'rea-stub'); await mkdir(directory);
  const entry = path.join(directory, 'rea.mjs');
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'rea-agents', version: '6.4.0' }));
  await mkdir(path.join(directory, 'scripts'));
  const code = `
    import {Server} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/index.js'))};
    import {StdioServerTransport} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
    import {ListToolsRequestSchema} from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/types.js'))};
    if(process.argv.includes('--mcp')) {
      const server=new Server({name:'fixture-rea',version:'6.4.0'},{capabilities:{tools:{}}});
      server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:['open_binary','binary_overview','analyze_function','inspect_artifact'].map(name=>({name,inputSchema:{type:'object'}}))}));
      await server.connect(new StdioServerTransport());
      process.stdin.on('end',()=>{void server.close()});
    } else console.log(JSON.stringify({ok:true,data:{analysis_provider_candidates:[{provider:{id:'fixture',version:null},availability:{status:'unavailable',code:'not_configured',reason:'Fixture provider is deliberately absent',diagnostics:{}}}]}}));
  `;
  await writeFile(entry, code); await writeFile(path.join(directory, 'scripts', 'rea.mjs'), code);
  return { root: directory, entry, version: '6.4.0' };
}

test('native readiness is false without a deep provider even when REA MCP connects', async t => {
  const { root, service } = await workspace(t);
  service.config.rea = await stubRea(root);
  const result = await checkEnvironment(service.config, 'native', service.jobs);
  assert.equal(result.items.find(item => item.name === 'rea-mcp').state, 'verified');
  assert.equal(result.ready, false); assert.ok(result.missing.includes('native-provider'));
  assert.equal(result.capabilities.localStatic.available, true);
  assert.equal(result.capabilities.nativeDeep.providers[0].code, 'not_configured');
});

test('both local MCP entrypoints are diagnosed without claiming host tool exposure', async t => {
  const { root, service } = await workspace(t);
  service.config.rea = await stubRea(root);
  const result = await service.diagnoseConnections();
  assert.equal(result.ready, true);
  assert.equal(result.hostToolExposure, 'not_verified');
  assert.equal(result.entrypoints.length, 2);
  assert.ok(result.entrypoints.every(entry => entry.state === 'verified'));
  assert.ok(result.entrypoints[0].toolSample.includes('analysis_inspect_local'));
  assert.equal(service.operations.list().length, 0);
});
