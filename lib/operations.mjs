import { randomUUID } from 'node:crypto';

export class OwnedOperations {
  #active = new Map();
  #ending = false;
  list(projectId) { return [...this.#active.values()].filter(item => !projectId || item.projectId === projectId)
    .map(({ id, projectId, kind, startedAt }) => ({ id, projectId, kind, startedAt })); }
  async run(projectId, kind, action, signal) {
    if (this.#ending || signal?.aborted) throw new Error('Operation cancelled');
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const id = 'o_' + randomUUID().replaceAll('-', '').slice(0, 16);
    let resolveDone;
    const done = new Promise(resolve => { resolveDone = resolve; });
    this.#active.set(id, { id, projectId, kind, startedAt: new Date().toISOString(), controller, done });
    try { return await action(controller.signal); }
    finally { signal?.removeEventListener('abort', abort); this.#active.delete(id); resolveDone(); }
  }
  async stop(projectId) {
    const active = [...this.#active.values()].filter(item => !projectId || item.projectId === projectId);
    for (const item of active) item.controller.abort(new Error('Project operation stopped'));
    await Promise.all(active.map(item => item.done));
    return { requested: active.map(item => item.id), remaining: this.list(projectId) };
  }
  async shutdown() { this.#ending = true; return this.stop(); }
}
