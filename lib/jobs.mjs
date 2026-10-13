import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export class JobManager {
  #jobs = new Map();
  #stopping = false;

  list(projectId) {
    return [...this.#jobs.values()].filter(job => !projectId || job.projectId === projectId)
      .map(job => ({ jobId: job.jobId, projectId: job.projectId, pid: job.child.pid, startedAt: job.startedAt }));
  }

  async run(projectId, command, args, { timeoutMs = 90000, maxBytes = 8 * 1024 * 1024, signal, cwd, env } = {}) {
    if (this.#stopping || signal?.aborted) throw new Error('Analysis process has been cancelled');
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const jobId = 'j_' + randomUUID().replaceAll('-', '').slice(0, 16);
    const job = { jobId, projectId, child, startedAt: new Date().toISOString(), termination: null };
    job.finished = new Promise(resolve => child.once('close', resolve));
    this.#jobs.set(jobId, job);
    return new Promise((resolve, reject) => {
      let stdout = [], stderr = [], bytes = 0;
      const collect = (bucket, chunk) => {
        bytes += chunk.length;
        if (bytes > maxBytes) { void this.#terminate(job, 'output_limit'); return; }
        bucket.push(chunk);
      };
      child.stdout.on('data', chunk => collect(stdout, chunk));
      child.stderr.on('data', chunk => collect(stderr, chunk));
      const cancel = () => { void this.#terminate(job, 'cancelled'); };
      signal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(() => { void this.#terminate(job, 'timeout'); }, timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); this.#jobs.delete(jobId); };
      child.on('error', error => { cleanup(); reject(error); });
      child.on('close', (exitCode, exitSignal) => {
        cleanup();
        resolve({ jobId, exitCode, exitSignal, termination: job.termination,
          stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
      });
    });
  }

  async #terminate(job, reason) {
    if (job.termination || job.child.exitCode !== null || job.child.signalCode !== null) { await job.finished; return; }
    job.termination = reason;
    await terminateOwnedChild(job.child);
    await job.finished;
  }

  async stop(projectId) {
    const jobs = [...this.#jobs.values()].filter(job => !projectId || job.projectId === projectId);
    await Promise.all(jobs.map(job => this.#terminate(job, 'cancelled')));
    return { requested: jobs.map(job => job.jobId), remaining: this.list(projectId) };
  }

  async shutdown() { this.#stopping = true; return this.stop(); }
}

export async function terminateOwnedChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
      killer.once('error', () => { child.kill(); resolve(); });
      killer.once('close', code => { if (code !== 0) child.kill(); resolve(); });
    });
  } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}
