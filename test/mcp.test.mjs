import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT } from '../lib/config.mjs';
import { workspace } from './helpers.mjs';

test('MCP stdin closure stops an active owned analysis process', async t => {
  const { root, target } = await workspace(t);
  const reaRoot = path.join(root, 'rea-stub');
  await mkdir(path.join(reaRoot, 'scripts'), { recursive: true });
  await writeFile(path.join(reaRoot, 'package.json'), JSON.stringify({ name: 'rea-agents', version: 'test' }));
  await writeFile(path.join(reaRoot, 'scripts', 'rea.mjs'), 'setInterval(() => {}, 1000);');
  const client = new Client({ name: 'eof-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'mcp', 'server.mjs')],
    env: { ...process.env, SOFTWARE_ANALYSIS_REA_ROOT: reaRoot, SOFTWARE_ANALYSIS_HOME: path.join(root, 'mcp-workspace'),
      SOFTWARE_ANALYSIS_RUNTIME_HOME: path.join(root, 'mcp-runtime') }, stderr: 'pipe' }));
  const created = await client.callTool({ name: 'analysis_create_project', arguments: { targetPath: target, goal: '检查退出清理' } });
  const project = created.structuredContent;
  const pending = client.callTool({ name: 'analysis_run_static', arguments: { projectId: project.id, profile: 'artifact' } }).catch(() => null);
  let pid = null;
  for (let attempt = 0; attempt < 40 && !pid; attempt++) {
    const status = await client.callTool({ name: 'analysis_status', arguments: {} });
    pid = status.structuredContent.activeJobs[0]?.pid;
    if (!pid) await delay(25);
  }
  assert.ok(pid, 'Owned analysis job did not start');
  await client.close();
  await pending;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { process.kill(pid, 0); await delay(25); }
    catch (error) { assert.equal(error.code, 'ESRCH'); return; }
  }
  assert.fail('Owned analysis job remained running after MCP closure');
});
