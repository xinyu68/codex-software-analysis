import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, loadConfig } from '../lib/config.mjs';
import { AnalysisService } from '../lib/service.mjs';
import { ReaSession } from '../lib/rea-session.mjs';
import { createLearningApk } from '../test/fixtures/android.mjs';

const runRoot = path.join(ROOT, '.runtime', 'android-verification', String(Date.now()));
await mkdir(runRoot, { recursive: true });
const config = await loadConfig({ ...process.env, SOFTWARE_ANALYSIS_HOME: path.join(runRoot, 'workspace') });
const service = new AnalysisService(config), session = new ReaSession(config);
const verification = { verifiedAt: new Date().toISOString(), remoteBusinessCalls: false, targetExecuted: false };
try {
  const environment = await service.checkEnvironment({ profile: 'android' });
  assert.ok(environment.ready, JSON.stringify(environment)); verification.environment = environment;
  const file = path.join(runRoot, 'learning.apk');
  verification.fixture = await createLearningApk(file);
  const project = await service.projects.create(file, '检查学习 APK 的 answer 方法');
  const inspected = await service.runStatic({ projectId: project.id, profile: 'android', timeoutSeconds: 90 });
  assert.equal(inspected.status, 'completed', JSON.stringify(inspected));
  verification.static = inspected;
  await session.open();
  const tools = (await session.client.listTools()).tools;
  const selected = tools.find(tool => tool.name === 'inspect_android_method');
  assert.ok(selected, 'Android method source tool is missing');
  const args = { path: file, class_name: 'example.learning.Hello', method_name: 'answer' };
  for (const required of selected.inputSchema.required || []) { if (!(required in args)) throw new Error(`Verify the current method tool schema for ${required}`); }
  const method = await session.call(selected.name, args);
  assert.match(JSON.stringify(method), /return 7/);
  verification.method = method;
  const evidence = await service.projects.addEvidence(project.id, { payload: method, kind: 'static', description: '真实 JADX 反编译学习方法；未执行 APK' });
  await service.projects.recordFinding(project.id, { statement: '静态反编译的 answer 方法返回整数 7', level: 'static_inference', evidenceIds: [evidence.id] });
  verification.report = await service.projects.report(project.id);
  await service.close(project.id);
  console.log(JSON.stringify({ apkMetadata: inspected.status, methodDecompilation: true, targetExecuted: false, remoteBusinessCalls: false }, null, 2));
} finally { await session.close(); await service.shutdown(); await writeFile(path.join(runRoot, 'verification.json'), JSON.stringify(verification, null, 2)); }
