import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, realpath, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const inside = (root, file) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const idPattern = /^a_[a-f0-9]{16}$/;

async function fingerprint(root, signal) {
  const entries = []; let bytes = 0;
  async function visit(file, relative) {
    signal?.throwIfAborted();
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error('Artifact tree contains a symbolic link or junction');
    if (entries.length >= 10000) throw new Error('Artifact file count budget exceeded');
    if (info.isDirectory()) {
      entries.push({ path: relative, kind: 'directory' });
      for (const name of (await readdir(file)).sort()) await visit(path.join(file, name), path.join(relative, name));
    } else if (info.isFile()) {
      bytes += info.size;
      if (bytes > 512 * 1024 * 1024) throw new Error('Artifact size exceeds 512 MiB');
      const digest = createHash('sha256');
      for await (const chunk of createReadStream(file)) { signal?.throwIfAborted(); digest.update(chunk); }
      const after = await lstat(file);
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ino !== info.ino || after.isSymbolicLink()) throw new Error('Artifact changed while fingerprinting');
      entries.push({ path: relative, kind: 'file', bytes: info.size, sha256: digest.digest('hex') });
    } else throw new Error('Only regular files and directories can be managed');
  }
  await visit(root, '');
  return { sha256: hash(entries), bytes, entries };
}

async function ownedRoot(project, name, create = false) {
  const root = path.join(project.directory, name);
  if (create) await mkdir(root, { recursive: true });
  const info = await lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory() || path.dirname(await realpath(root)) !== project.directory) throw new Error('Artifact root is outside the project');
  return root;
}

async function artifactPath(project, artifact, quarantined = false) {
  if (!idPattern.test(artifact.id) || artifact.ownership !== 'workbench-created') throw new Error('Artifact is not owned by this workbench');
  const expected = path.join(quarantined ? '.trash' : 'artifacts', artifact.id);
  if ((quarantined ? artifact.quarantinePath : artifact.relativePath) !== expected) throw new Error('Invalid owned artifact path');
  const root = await ownedRoot(project, quarantined ? '.trash' : 'artifacts');
  const full = path.join(root, artifact.id), info = await lstat(full);
  if (info.isSymbolicLink() || path.dirname(await realpath(full)) !== root) throw new Error('Owned artifact path was redirected');
  if (project.target.targetPath) {
    const target = await realpath(project.target.targetPath).catch(error => { if (error.code === 'ENOENT') return path.resolve(project.target.targetPath); throw error; });
    if (inside(full, target) || inside(target, full)) throw new Error('Artifact intersects the original target');
  }
  return full;
}

async function copyTree(source, destination, signal) {
  signal?.throwIfAborted();
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error('Working copies do not follow symbolic links or junctions');
  if (info.isDirectory()) {
    await mkdir(destination);
    for (const name of (await readdir(source)).sort()) await copyTree(path.join(source, name), path.join(destination, name), signal);
  } else if (info.isFile()) await copyFile(source, destination, 1);
  else throw new Error('Working copies accept only regular files and directories');
}

export class ArtifactStore {
  constructor(projects) { this.projects = projects; }

  async createCopy(projectId, description, signal) {
    return this.projects.mutate(projectId, async project => {
      if (project.state !== 'open' || !project.target.targetPath) throw new Error('Working copies require an open local project');
      const source = await realpath(project.target.targetPath);
      if (inside(source, project.directory) || inside(project.directory, source)) throw new Error('Source and analysis project must be disjoint');
      const before = await fingerprint(source, signal);
      if (project.target.sha256 && before.entries[0]?.sha256 !== project.target.sha256) throw new Error('Target changed; create a new project');
      const id = 'a_' + randomUUID().replaceAll('-', '').slice(0, 16);
      const root = await ownedRoot(project, 'artifacts', true), container = path.join(root, id);
      await mkdir(container);
      const copyPath = path.join(container, path.basename(source));
      const artifact = { id, description, ownership: 'workbench-created', kind: 'working_copy',
        relativePath: path.join('artifacts', id), createdAt: new Date().toISOString(), state: 'active',
        originalPath: source, originalFingerprint: before.sha256 };
      try {
        await copyTree(source, copyPath, signal);
        const copied = await fingerprint(copyPath, signal), after = await fingerprint(source, signal);
        if (copied.sha256 !== before.sha256 || after.sha256 !== before.sha256) throw new Error('Source changed during copy');
        artifact.initialFingerprint = (await fingerprint(container, signal)).sha256;
      } catch (error) {
        // Keep failed partial copies explicitly owned and visible to cleanup instead of silently orphaning them.
        artifact.state = 'failed'; artifact.failure = error.message;
      }
      (project.artifacts ||= []).push(artifact);
      return { ...artifact, copyPath, executesTarget: false, nextStep: artifact.state === 'failed' ? 'Preview cleanup for this failed copy.' : 'Operate only on the copy when an experiment is authorized; the original was not changed.' };
    });
  }

  async registerReference(projectId, file, description) {
    if (!path.isAbsolute(file)) throw new Error('Artifact reference must be absolute');
    const canonical = await realpath(file);
    return this.projects.mutate(projectId, project => {
      if (project.state !== 'open') throw new Error('Project is closed');
      const artifact = { id: 'a_' + randomUUID().replaceAll('-', '').slice(0, 16), kind: 'reference', ownership: 'external',
        path: canonical, description, state: 'reference', createdAt: new Date().toISOString() };
      (project.artifacts ||= []).push(artifact);
      return { ...artifact, cleanupAllowed: false, reason: 'Registration records provenance; it does not prove that the workbench created this path.' };
    });
  }

  async plan(project) {
    const items = [];
    for (const artifact of project.artifacts || []) {
      if (artifact.ownership !== 'workbench-created') { items.push({ id: artifact.id, action: 'preserve', reason: 'external-reference' }); continue; }
      if (artifact.state === 'quarantined') { items.push({ id: artifact.id, action: 'preserve', reason: 'already-quarantined' }); continue; }
      try {
        const file = await artifactPath(project, artifact), inventory = await fingerprint(file);
        items.push({ id: artifact.id, action: 'quarantine', path: file, sha256: inventory.sha256, bytes: inventory.bytes,
          changedSinceCreation: artifact.initialFingerprint ? artifact.initialFingerprint !== inventory.sha256 : null });
      } catch (error) { items.push({ id: artifact.id, action: 'blocked', reason: error.message }); }
    }
    return { projectId: project.id, planId: hash({ projectId: project.id, items }), items,
      effect: 'Only workbench-created artifacts move to this project\'s .trash directory. No permanent deletion, process termination or original-file modification.' };
  }

  async cleanup(projectId, { apply = false, planId } = {}) {
    if (!apply) return this.plan(await this.projects.load(projectId));
    if (!planId) throw new Error('Preview cleanup first and pass its planId');
    return this.projects.mutate(projectId, async project => {
      const plan = await this.plan(project);
      if (plan.planId !== planId) throw new Error('Cleanup plan is stale; preview again');
      if (plan.items.some(item => item.action === 'blocked')) throw new Error('Cleanup contains blocked paths; nothing was moved');
      const trash = await ownedRoot(project, '.trash', true), results = [];
      for (const item of plan.items.filter(item => item.action === 'quarantine')) {
        const artifact = project.artifacts.find(a => a.id === item.id);
        try {
          const source = await artifactPath(project, artifact), check = await fingerprint(source);
          if (check.sha256 !== item.sha256) throw new Error('Artifact changed after cleanup preview');
          const destination = path.join(trash, artifact.id);
          if (await lstat(destination).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) throw new Error('Quarantine destination already exists');
          await rename(source, destination);
          artifact.state = 'quarantined'; artifact.quarantinePath = path.join('.trash', artifact.id);
          artifact.quarantinedFingerprint = check.sha256; artifact.quarantinedAt = new Date().toISOString();
          results.push({ id: artifact.id, status: 'quarantined', path: destination });
        } catch (error) { results.push({ id: artifact.id, status: 'failed', reason: error.message }); break; }
      }
      return { ...plan, applied: true, results };
    });
  }

  async restore(projectId, artifactId) {
    return this.projects.mutate(projectId, async project => {
      const artifact = (project.artifacts || []).find(item => item.id === artifactId);
      if (!artifact || artifact.state !== 'quarantined') throw new Error('Select a quarantined artifact');
      const source = await artifactPath(project, artifact, true), current = await fingerprint(source);
      if (current.sha256 !== artifact.quarantinedFingerprint) throw new Error('Quarantined artifact changed');
      const root = await ownedRoot(project, 'artifacts', true), destination = path.join(root, artifact.id);
      if (await lstat(destination).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) throw new Error('Restore destination already exists');
      await rename(source, destination);
      artifact.state = 'active'; artifact.restoredAt = new Date().toISOString();
      delete artifact.quarantinePath; delete artifact.quarantinedFingerprint;
      return { artifactId, state: artifact.state, path: destination };
    });
  }
}
