import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AnalysisService } from '../lib/service.mjs';
import { loadConfig, ROOT } from '../lib/config.mjs';

const runRoot = path.join(ROOT, '.runtime', 'local-verification', String(Date.now()));
await mkdir(runRoot, { recursive: true });
const config = await loadConfig({ ...process.env, SOFTWARE_ANALYSIS_HOME: path.join(runRoot, 'workspace') });
const service = new AnalysisService(config);
const results = { observedAt: new Date().toISOString(), executesSelectedFile: false, remoteBusinessCalls: false };
let child;
try {
  results.environment = await service.checkEnvironment({ profile: 'native' });
  assert.equal(results.environment.capabilities.localStatic.available, true);
  assert.equal(results.environment.capabilities.nativeDeep.targetVerified, false);
  const target = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32/where.exe') : path.join(ROOT, 'test/fixtures/javascript-app/package.json');
  const project = await service.projects.create(target, 'Read-only host utility metadata; do not execute it');
  results.localInspection = await service.inspectLocal({ projectId: project.id, maxStrings: 20 });
  const evidence = JSON.parse((await service.projects.readEvidence(project.id, results.localInspection.evidenceId, 0, 24000)).text);
  assert.equal(evidence.effects.executesTarget, false);
  if (process.platform === 'win32') {
    assert.equal(results.localInspection.peStatus, 'parsed');
    assert.equal(evidence.windows.status, 'completed');
    assert.ok(evidence.windows.fileVersion);
    assert.equal(evidence.pe.embeddedSignature.trustVerification, 'not_performed');
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
    await once(child, 'spawn');
    const running = await service.projects.create(process.execPath, 'Observe only the verifier-owned idle Node fixture');
    results.processSnapshot = await service.snapshotProcess({ projectId: running.id, pid: child.pid, samples: 2, intervalMs: 250 });
    await service.projects.recordFinding(running.id, { statement: 'The owned fixture was observed in two bounded connection-table samples',
      level: 'live_verified', evidenceIds: [results.processSnapshot.evidenceId], limitations: 'Not a packet capture or isolation test',
      verification: { method: 'process_snapshot', observedBy: 'tool', subject: 'Verifier-owned idle Node fixture', coverage: 'Two samples only',
        networkScope: 'connection_snapshot', startedAt: results.processSnapshot.startedAt, endedAt: results.processSnapshot.endedAt } });
    await service.projects.report(running.id); await service.close(running.id);
  }
  results.report = await service.projects.report(project.id);
  await service.close(project.id);
  console.log(JSON.stringify({ localInspection: results.localInspection.peStatus, fileMetadata: evidence.windows.status,
    samples: results.processSnapshot?.sampleCount || 0, nativeReady: results.environment.ready,
    basicStaticReady: results.environment.capabilities.localStatic.available,
    nativeProviders: results.environment.capabilities.nativeDeep.providers.map(provider => ({ id: provider.id, state: provider.state, code: provider.code })),
    remoteBusinessCalls: false }, null, 2));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'close'); }
  await service.shutdown();
  await writeFile(path.join(runRoot, 'verification.json'), JSON.stringify(results, null, 2));
}
