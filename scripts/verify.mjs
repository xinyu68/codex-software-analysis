import assert from 'node:assert/strict';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT, exists } from '../lib/config.mjs';
import { ensureRuntime, RUNTIME_FILES } from './runtime.mjs';

const runRoot = path.join(ROOT, '.runtime', 'verification', String(Date.now()));
await mkdir(runRoot, { recursive: true });
const env = { ...process.env, SOFTWARE_ANALYSIS_HOME: path.join(runRoot, 'workspace'), SOFTWARE_ANALYSIS_RUNTIME_HOME: path.join(runRoot, 'runtime') };
await ensureRuntime({ env, install: true });
// Exercise the layout used by a cached plugin: no node_modules and no source-local machine settings.
const cacheRoot = path.join(runRoot, 'cache-source');
for (const relative of [...RUNTIME_FILES, 'scripts/runtime.mjs', 'scripts/plugin-mcp.mjs']) {
  const destination = path.join(cacheRoot, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(path.join(ROOT, relative), destination);
}
const verification = { verifiedAt: new Date().toISOString(), realBusinessApisContacted: false };
let client;
try {
  client = new Client({ name: 'software-analysis-verifier', version: '0.2.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(cacheRoot, 'scripts', 'plugin-mcp.mjs')], env, stderr: 'pipe' }));
  const discovered = await client.listTools();
  verification.orchestrationTools = discovered.tools.map(tool => tool.name);
  assert.equal(discovered.tools.length, 13);
  const invoke = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
    assert.ok(!result.isError, result.content?.[0]?.text);
    return result.structuredContent || JSON.parse(result.content[0].text);
  };
  const status = await invoke('analysis_status');
  assert.ok(status.rea.entry, 'A local REA installation is required for the integration verifier');
  verification.reaVersion = status.rea.version;
  verification.cachedPluginWithoutNodeModules = true;
  const created = await invoke('analysis_create_project', { targetPath: path.join(ROOT, 'test', 'fixtures', 'javascript-app'), goal: '检查 normalizeQuery 与 findEntries 的静态实现' });
  const run = await invoke('analysis_run_static', { projectId: created.id, profile: 'javascript', timeoutSeconds: 90 });
  assert.equal(run.status, 'completed', JSON.stringify(run));
  verification.realReaStaticRun = run;
  const viewed = await invoke('analysis_read_evidence', { projectId: created.id, evidenceId: run.evidenceId, limit: 24000 });
  assert.match(viewed.text, /normalizeQuery/);
  await invoke('analysis_record_finding', { projectId: created.id, statement: '静态材料包含 normalizeQuery 实现，尚未验证实际运行行为。', level: 'static_inference', evidenceIds: [run.evidenceId], limitations: '学习样本；未执行目标代码' });
  verification.report = await invoke('analysis_report', { projectId: created.id });
  verification.closedProject = await invoke('analysis_close_project', { projectId: created.id });
  assert.equal(verification.closedProject.processes.remaining.length, 0);
  verification.additionalProfiles = [];
  const samples = [{ profile: 'har', targetPath: path.join(ROOT, 'test', 'fixtures', 'example.har') }];
  const managedSample = process.env.SOFTWARE_ANALYSIS_MANAGED_FIXTURE || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'System.Management.Automation.dll');
  if (process.platform === 'win32' && await exists(managedSample)) samples.push({ profile: 'managed', targetPath: managedSample });
  for (const sample of samples) {
    const project = await invoke('analysis_create_project', { targetPath: sample.targetPath, goal: `验证 ${sample.profile} 的本地静态入口` });
    const analysis = await invoke('analysis_run_static', { projectId: project.id, profile: sample.profile, timeoutSeconds: 90 });
    verification.additionalProfiles.push({ profile: sample.profile, type: project.target.type, status: analysis.status, providerErrorCode: analysis.providerErrorCode });
    assert.equal(analysis.status, 'completed', JSON.stringify(analysis));
    await invoke('analysis_close_project', { projectId: project.id });
  }
  await client.close();
  client = new Client({ name: 'rea-launcher-verifier', version: '0.2.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(cacheRoot, 'scripts', 'plugin-mcp.mjs'), 'rea'], env, stderr: 'pipe' }));
  const reaTools = await client.listTools();
  verification.reaMcpTools = reaTools.tools.map(tool => tool.name);
  assert.ok(reaTools.tools.length > 10);
  console.log(JSON.stringify({ orchestrationToolCount: discovered.tools.length, reaMcpToolCount: reaTools.tools.length,
    reaVersion: status.rea.version, staticAnalysis: run.status, additionalProfiles: verification.additionalProfiles,
    reportGenerated: true, remoteBusinessCalls: false }, null, 2));
} finally {
  await client?.close();
  await writeFile(path.join(runRoot, 'verification.json'), JSON.stringify(verification, null, 2));
}
