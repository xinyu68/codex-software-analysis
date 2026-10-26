import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../lib/config.mjs';
import { callTool } from '../mcp/tools.mjs';
import { inspectWebsite } from '../lib/target.mjs';
import { summarizeCapture } from '../lib/web.mjs';
import { workspace } from './helpers.mjs';

test('website creation is offline and rejects ambiguous or credential-bearing inputs', async t => {
  const { service, target } = await workspace(t);
  const project = await callTool(service, 'analysis_create_project', { targetUrl: 'https://example.invalid/?code=EXAMPLE', goal: '解释行情' });
  assert.equal(project.target.type, 'website');
  await assert.rejects(callTool(service, 'analysis_create_project', { targetUrl: 'https://example.invalid/', targetPath: target, goal: 'ambiguous' }), /Invalid arguments/);
  assert.throws(() => inspectWebsite('file:///C:/private'), /HTTP/);
  assert.throws(() => inspectWebsite('https://example.invalid/?token=private'), /credentials/);
  assert.throws(() => inspectWebsite('https://example.invalid/#access_token=private'), /credentials/);
});

test('a transport-budget failure exports retained capture and closes owned resources', async t => {
  const { service, root } = await workspace(t);
  service.config.rea = { entry: path.join(ROOT, 'test/fixtures/rea-mcp-stub.mjs') };
  service.config.browserExecutable = path.join(root, 'browser-placeholder');
  await writeFile(service.config.browserExecutable, 'fixture');
  const project = await service.projects.create(null, '学习采集', null, 'https://example.invalid/');
  const result = await service.captureWebsite({ projectId: project.id, observeMs: 100, timeoutSeconds: 20 });
  assert.equal(result.transportBudgetFallback, true);
  assert.equal(result.cleanup, 'closed');
  assert.equal(result.status, 'completed');
  assert.equal(service.operations.list().length, 0);
  const summary = await service.projects.readEvidence(project.id, result.networkEvidenceId);
  assert.ok(!summary.text.includes('fixture-secret'));
  assert.match(summary.text, /acs_token/);
  assert.equal((JSON.parse(summary.text)).endpoints[0].statuses[0], 200);
  assert.ok((await readFile(result.rawCapturePath, 'utf8')).includes('fixture-secret'));
  await service.close(project.id);
});

test('verification pages and WebSocket heartbeats are recorded without asserting quote success', () => {
  const summary = summarizeCapture({ steps: [{ status: 'completed', after_url: { url: 'https://example.invalid/captcha' }, artifacts: { accessibility: { value: { text: '安全验证' } } } }], events: { items: [{ kind: 'websocket-frame-received', url: { url: 'wss://example.invalid/?token=fixture-sensitive-value' }, payload_text: '{"data":"pong"}' }], dropped: 0 } });
  assert.equal(summary.pageAccess, 'verification_page_observed');
  assert.ok(!JSON.stringify(summary).includes('fixture-sensitive-value'));
  assert.match(summary.limitations.join('\n'), /do not alone prove/);
});

test('large evidence pages verify integrity and credential URL values stay filtered', async t => {
  const { root, target, service } = await workspace(t);
  const project = await service.projects.create(target, '检查大证据');
  const file = path.join(root, 'large.txt');
  const original = '中文😀'.repeat(400000) + '\nhttps://example.invalid/?acs_token=private&code=EXAMPLE';
  await writeFile(file, original);
  const evidence = await service.importEvidence({ projectId: project.id, sourcePath: file, kind: 'runtime', description: '超过旧版 2 MiB 的学习样本' });
  assert.ok(evidence.sizeBytes > 2 * 1024 * 1024);
  const page = await service.projects.readEvidence(project.id, evidence.id, 260003, 37);
  assert.equal(page.text, original.slice(260003, 260040));
  const end = await service.projects.readEvidence(project.id, evidence.id, 1600000, 300);
  assert.ok(!end.text.includes('acs_token=private'));
  await writeFile(path.join(project.directory, evidence.relativePath), 'changed');
  await assert.rejects(service.projects.readEvidence(project.id, evidence.id), /digest mismatch/);
});

test('authentication findings require evidence and preserve the verified scope', async t => {
  const { target, service } = await workspace(t);
  const project = await service.projects.create(target, '解释会话');
  const evidence = await service.projects.addEvidence(project.id, { payload: 'OAuth response observed', kind: 'network_capture', description: '学习样本' });
  await callTool(service, 'analysis_record_auth', { projectId: project.id, statement: '服务器签发会话', level: 'live_verified', evidenceIds: [evidence.id], mechanism: 'server_issued_session', tokenSource: 'server', expiresSeconds: 7200, renewal: 'refresh_token', verifiedScope: '仅授权响应，未验证行情',
    verification: { method: 'network_capture', observedBy: 'tool', subject: '本地授权学习样本', coverage: '仅授权响应', networkScope: 'capture_window', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:00:01Z' } });
  const report = await service.projects.report(project.id);
  assert.match(await readFile(report.reportPath, 'utf8'), /仅授权响应，未验证行情/);
  await assert.rejects(callTool(service, 'analysis_record_auth', { projectId: project.id, statement: '伪结论', level: 'live_verified', evidenceIds: [], mechanism: 'unknown', tokenSource: 'unknown', verifiedScope: 'unknown' }), /reference evidence/);
});
