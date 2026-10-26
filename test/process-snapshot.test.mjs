import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { workspace } from './helpers.mjs';

test('Windows process snapshots bind to one executable and report a bounded connection-table scope', { skip: process.platform !== 'win32' }, async t => {
  const { target, service } = await workspace(t);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  await once(child, 'spawn');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'close'); } });
  const wrong = await service.projects.create(target, 'Mismatched executable fixture');
  await assert.rejects(service.snapshotProcess({ projectId: wrong.id, pid: child.pid, samples: 1 }), /does not match/);
  const project = await service.projects.create(process.execPath, 'Owned idle fixture process');
  const result = await service.snapshotProcess({ projectId: project.id, pid: child.pid, samples: 2, intervalMs: 250 });
  assert.equal(result.sampleCount, 2); assert.equal(result.networkScope, 'connection_snapshot');
  const viewed = await service.projects.readEvidence(project.id, result.evidenceId);
  const evidence = JSON.parse(viewed.text);
  assert.equal(evidence.pid, child.pid); assert.equal(evidence.isolationVerified, false);
  assert.equal(evidence.snapshots.length, 2);
  assert.ok(Date.parse(evidence.endedAt) >= Date.parse(evidence.startedAt));
});
