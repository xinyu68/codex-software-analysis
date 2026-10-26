import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT, VERSION } from '../lib/config.mjs';
import { startWebsiteFixture } from '../test/fixtures/website.mjs';

const runRoot = path.join(ROOT, '.runtime', 'web-verification', String(Date.now()));
await mkdir(runRoot, { recursive: true });
const fixture = await startWebsiteFixture();
const client = new Client({ name: 'website-verifier', version: VERSION });
const verification = { verifiedAt: new Date().toISOString(), remoteBusinessCalls: false };
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'mcp/server.mjs')], stderr: 'pipe',
    env: { ...process.env, SOFTWARE_ANALYSIS_HOME: path.join(runRoot, 'workspace'), SOFTWARE_ANALYSIS_RUNTIME_HOME: path.join(runRoot, 'runtime') } }));
  const invoke = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
    assert.ok(!result.isError, result.content?.[0]?.text); return result.structuredContent;
  };
  const environment = await invoke('analysis_check_environment', { profile: 'web' });
  assert.ok(environment.ready, JSON.stringify(environment));
  verification.environment = environment;
  const project = await invoke('analysis_create_project', { targetUrl: fixture.url + '/', goal: '验证本地 HTTP、WebSocket、脚本导出和加载等待' });
  const captured = await invoke('analysis_capture_website', { projectId: project.id, observeMs: 1500, timeoutSeconds: 60 });
  assert.equal(captured.status, 'completed');
  assert.equal(captured.cleanup, 'closed');
  assert.ok(captured.scriptCount >= 2);
  const network = JSON.parse((await invoke('analysis_read_evidence', { projectId: project.id, evidenceId: captured.networkEvidenceId })).text);
  assert.ok(network.endpoints.some(item => item.path === '/quote' && item.statuses.includes(200)));
  assert.ok(network.websockets.some(item => item.kind === 'websocket-frame-received'));
  assert.ok(!JSON.stringify(network).includes('fixture-sensitive-value'));
  const page = await invoke('analysis_read_evidence', { projectId: project.id, evidenceId: captured.pageEvidenceId });
  assert.match(page.text, /101/);
  const analyzed = await invoke('analysis_run_static', { projectId: project.id, profile: 'javascript', timeoutSeconds: 90 });
  assert.equal(analyzed.status, 'completed');
  await invoke('analysis_record_finding', { projectId: project.id, statement: '本地学习页面完成 HTTP 报价和 WebSocket 报价展示', level: 'live_verified', evidenceIds: [captured.networkEvidenceId, captured.pageEvidenceId] });
  verification.normal = { ...captured, staticAnalysis: analyzed, report: await invoke('analysis_report', { projectId: project.id }) };
  await invoke('analysis_close_project', { projectId: project.id });
  const challenge = await invoke('analysis_create_project', { targetUrl: fixture.url + '/challenge', goal: '记录验证页，不将页面状态误判为业务成功' });
  verification.challenge = await invoke('analysis_capture_website', { projectId: challenge.id, observeMs: 100, timeoutSeconds: 30 });
  assert.equal(verification.challenge.pageAccess, 'verification_page_observed');
  assert.equal(verification.challenge.status, 'partial');
  await invoke('analysis_close_project', { projectId: challenge.id });
  const cancelled = await invoke('analysis_create_project', { targetUrl: fixture.url + '/', goal: '验证关闭项目能够取消浏览器观察' });
  const pending = client.callTool({ name: 'analysis_capture_website', arguments: { projectId: cancelled.id, observeMs: 20000, timeoutSeconds: 60 } }, undefined, { timeout: 90000 });
  for (let attempt = 0; attempt < 100 && fixture.wsSockets.size === 0; attempt++) await delay(100);
  assert.ok(fixture.wsSockets.size > 0, 'The cancellation fixture did not connect');
  verification.cancelled = await invoke('analysis_close_project', { projectId: cancelled.id });
  const result = await pending;
  assert.ok(result.isError, 'Cancelled capture must not report success');
  assert.equal(verification.cancelled.operations.remaining.length, 0);
  for (let attempt = 0; attempt < 40 && fixture.wsSockets.size; attempt++) await delay(50);
  assert.equal(fixture.wsSockets.size, 0, 'An owned browser connection remained after cancellation');
  const status = await invoke('analysis_status');
  assert.equal(status.activeOperations.length, 0);
  assert.equal(status.activeJobs.length, 0);
  const eofProject = await invoke('analysis_create_project', { targetUrl: fixture.url + '/', goal: '验证 MCP 断开回收活动浏览器' });
  const eofCapture = client.callTool({ name: 'analysis_capture_website', arguments: { projectId: eofProject.id, observeMs: 20000, timeoutSeconds: 60 } }, undefined, { timeout: 90000 }).catch(() => null);
  for (let attempt = 0; attempt < 100 && fixture.wsSockets.size === 0; attempt++) await delay(100);
  assert.ok(fixture.wsSockets.size > 0);
  await client.close(); await eofCapture;
  for (let attempt = 0; attempt < 60 && fixture.wsSockets.size; attempt++) await delay(50);
  assert.equal(fixture.wsSockets.size, 0, 'MCP disconnect left an owned browser connection running');
  verification.mcpDisconnectCleanup = true;
  console.log(JSON.stringify({ normalCapture: captured.status, realTransportBudgetFallback: captured.transportBudgetFallback, exportedScripts: captured.scriptCount,
    javascript: analyzed.status, verificationPage: verification.challenge.status, cancellationCleanup: true, mcpDisconnectCleanup: true, remoteBusinessCalls: false }, null, 2));
} finally {
  await client.close(); await fixture.close();
  await writeFile(path.join(runRoot, 'verification.json'), JSON.stringify(verification, null, 2));
}
