import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { callTool } from '../mcp/tools.mjs';
import { inspectTarget } from '../lib/target.mjs';
import { workspace } from './helpers.mjs';

test('files are fingerprinted without execution; changing the target is detected', async t => {
  const { target, service } = await workspace(t);
  const project = await service.projects.create(target, '解释导出');
  assert.equal(project.target.type, 'source_file');
  assert.match(project.target.sha256, /^[a-f0-9]{64}$/);
  await writeFile(target, 'export const example = 2;');
  assert.notEqual((await inspectTarget(target)).sha256, project.target.sha256);
  service.config.rea = { entry: 'must-not-be-launched.mjs' };
  await assert.rejects(service.runStatic({ projectId: project.id, profile: 'artifact' }), /Target changed/);
});

test('validation refuses traversal IDs, unknown arguments and arbitrary commands', async t => {
  const { service } = await workspace(t);
  await assert.rejects(callTool(service, 'analysis_get_project', { projectId: '../outside' }), /Invalid arguments/);
  await assert.rejects(callTool(service, 'analysis_status', { command: 'anything' }), /Invalid arguments/);
  await assert.rejects(callTool(service, 'analysis_run_static', { projectId: 'p_1234567890abcdef', profile: 'shell' }), /Invalid arguments/);
});

test('concurrent findings retain every update and require real evidence references', async t => {
  const { target, service } = await workspace(t);
  const project = await service.projects.create(target, '检查并发保存');
  const evidence = await service.projects.addEvidence(project.id, { payload: 'source has export example', kind: 'static', description: '本地代码' });
  await Promise.all(Array.from({ length: 12 }, (_, i) => service.projects.recordFinding(project.id, {
    statement: `观察 ${i}`, level: 'observed', evidenceIds: [evidence.id],
  })));
  assert.equal((await service.projects.load(project.id)).findings.length, 12);
  await assert.rejects(service.projects.recordFinding(project.id, { statement: '已运行', level: 'live_verified', evidenceIds: [evidence.id] }), /runtime/);
  await assert.rejects(service.projects.recordFinding(project.id, { statement: '不存在', level: 'observed', evidenceIds: ['e_1234567890abcdef'] }), /unknown evidence/);
});

test('credential patterns are filtered; evidence corruption is rejected; reports preserve uncertainty', async t => {
  const { target, service } = await workspace(t);
  const project = await service.projects.create(target, '检验证据');
  const evidence = await service.projects.addEvidence(project.id, { kind: 'runtime', description: '学习样本',
    payload: '{"access_token":"private-value", "authorization":"Bearer private-token", "result":42}' });
  const viewed = await service.projects.readEvidence(project.id, evidence.id);
  assert.ok(!viewed.text.includes('private-value'));
  assert.ok(!viewed.text.includes('private-token'));
  await service.projects.recordFinding(project.id, { statement: '样本返回 42', level: 'live_verified', evidenceIds: [evidence.id], limitations: '仅样本验证' });
  const report = await service.projects.report(project.id);
  assert.match(await readFile(report.reportPath, 'utf8'), /仅样本验证/);
  await writeFile(path.join(project.directory, evidence.relativePath), 'tampered');
  await assert.rejects(service.projects.readEvidence(project.id, evidence.id), /digest mismatch/);
});

test('closing a project preserves files and rejects new evidence', async t => {
  const { target, service } = await workspace(t);
  const project = await service.projects.create(target, '关闭项目');
  await service.close(project.id);
  assert.equal((await service.projects.load(project.id)).state, 'closed');
  await assert.rejects(service.projects.addEvidence(project.id, { payload: 'new', kind: 'static', description: '新材料' }), /closed/);
  assert.ok((await service.projects.report(project.id)).reportPath);
});

test('a directory junction cannot redirect evidence reads outside the project', async t => {
  const { root, target, service } = await workspace(t);
  const project = await service.projects.create(target, '路径边界');
  const evidence = await service.projects.addEvidence(project.id, { payload: 'original', kind: 'static', description: '材料' });
  const evidenceDirectory = path.join(project.directory, 'evidence');
  const movedDirectory = evidenceDirectory + '.original';
  assert.ok(path.resolve(evidenceDirectory).startsWith(path.resolve(root) + path.sep));
  assert.ok(path.resolve(movedDirectory).startsWith(path.resolve(root) + path.sep));
  await rename(evidenceDirectory, movedDirectory);
  const outside = path.join(root, 'outside-project');
  await mkdir(outside);
  await writeFile(path.join(outside, evidence.id + '.txt'), 'outside');
  await symlink(outside, evidenceDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(service.projects.readEvidence(project.id, evidence.id), /outside the project/);
});

test('a zero-exit provider error is recorded as failure rather than a successful analysis', async t => {
  const { root, target, service } = await workspace(t);
  const entry = path.join(root, 'provider-error.mjs');
  await writeFile(entry, `console.log(JSON.stringify({result:{error:{code:'backend_unavailable'}}}));`);
  service.config.rea = { entry };
  const project = await service.projects.create(target, '验证失败判定');
  const result = await service.runStatic({ projectId: project.id, profile: 'artifact' });
  assert.equal(result.status, 'failed');
  assert.equal(result.providerErrorCode, 'backend_unavailable');
});
