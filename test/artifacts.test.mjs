import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile, access, unlink } from 'node:fs/promises';
import path from 'node:path';
import { workspace } from './helpers.mjs';

test('working copy cleanup is previewed, stale plans fail, and quarantine restores without touching the original', async t => {
  const { target, service } = await workspace(t);
  const original = await readFile(target), project = await service.projects.create(target, 'Reversible experiment');
  const copy = await service.createWorkingCopy({ projectId: project.id, description: 'Fixture copy' });
  assert.equal(copy.state, 'active');
  await service.artifacts.registerReference(project.id, target, 'Original must never be cleaned');
  const old = await service.artifacts.cleanup(project.id);
  assert.equal(old.items.find(item => item.id !== copy.id).action, 'preserve');
  await assert.rejects(service.artifacts.cleanup(project.id, { apply: true }), /Preview/);
  await writeFile(copy.copyPath, 'modified experiment');
  await assert.rejects(service.artifacts.cleanup(project.id, { apply: true, planId: old.planId }), /stale/);
  assert.equal(await readFile(copy.copyPath, 'utf8'), 'modified experiment');
  const plan = await service.artifacts.cleanup(project.id);
  assert.equal(plan.items[0].changedSinceCreation, true);
  const cleaned = await service.artifacts.cleanup(project.id, { apply: true, planId: plan.planId });
  assert.equal(cleaned.results[0].status, 'quarantined');
  await assert.rejects(access(copy.copyPath));
  assert.deepEqual(await readFile(target), original);
  const restored = await service.artifacts.restore(project.id, copy.id);
  assert.equal(await readFile(path.join(restored.path, path.basename(target)), 'utf8'), 'modified experiment');
  assert.deepEqual(await readFile(target), original);
});

test('cleanup fails closed on a junction inside an owned copy', async t => {
  const { root, service } = await workspace(t);
  const directory = path.join(root, 'input'), outside = path.join(root, 'outside');
  await mkdir(directory); await mkdir(outside); await writeFile(path.join(directory, 'sample.txt'), 'sample');
  const project = await service.projects.create(directory, 'Junction protection');
  const copy = await service.createWorkingCopy({ projectId: project.id, description: 'Folder copy' });
  await symlink(outside, path.join(copy.copyPath, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
  const plan = await service.artifacts.cleanup(project.id);
  assert.equal(plan.items[0].action, 'blocked');
  await assert.rejects(service.artifacts.cleanup(project.id, { apply: true, planId: plan.planId }), /blocked/);
  await access(outside); await access(copy.copyPath);
});

test('a closed project permits cleanup of owned copies but cannot create a new experiment', async t => {
  const { target, service } = await workspace(t);
  const project = await service.projects.create(target, 'Close lifecycle');
  await service.createWorkingCopy({ projectId: project.id, description: 'Close fixture' });
  await service.close(project.id);
  await assert.rejects(service.createWorkingCopy({ projectId: project.id, description: 'Too late' }), /open/);
  const plan = await service.artifacts.cleanup(project.id);
  assert.equal((await service.artifacts.cleanup(project.id, { apply: true, planId: plan.planId })).results[0].status, 'quarantined');
});

test('removing the source separately does not orphan a workbench-owned copy', async t => {
  const { target, service } = await workspace(t);
  const project = await service.projects.create(target, 'Source already removed');
  await service.createWorkingCopy({ projectId: project.id, description: 'Owned fixture' });
  await unlink(target);
  const plan = await service.artifacts.cleanup(project.id);
  assert.equal(plan.items[0].action, 'quarantine');
  assert.equal((await service.artifacts.cleanup(project.id, { apply: true, planId: plan.planId })).results[0].status, 'quarantined');
});
