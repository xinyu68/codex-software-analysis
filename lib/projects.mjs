import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareWorkspace, readJSON } from './config.mjs';
import { inspectTarget, inspectWebsite } from './target.mjs';

export const LEVELS = ['observed', 'static_inference', 'live_verified', 'unknown'];

export function redact(text) {
  return text.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/((?:access_token|refresh_token|client_secret|password|authorization|acs_token|goldtoken|api_key)["']?\s*[:=]\s*["']?)([^\s,"'\r\n}]+)/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|acs_token|access_token|refresh_token|api_key|password|secret)=)[^&\s"'<>\\]*/gi, '$1[REDACTED]');
}

async function atomicJSON(file, value) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temporary, file);
}

async function ownedFile(directory, relativePath) {
  const candidate = path.join(directory, relativePath);
  const parent = await realpath(path.dirname(candidate));
  const relative = path.relative(directory, parent);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Evidence/report directory is outside the project');
  const link = await lstat(candidate).then(info => info.isSymbolicLink()).catch(error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (link) throw new Error('Evidence/report cannot be a symbolic link');
  return candidate;
}

export class ProjectStore {
  #locks = new Map();
  constructor(config) { this.config = config; }

  async directory(projectId) {
    if (!/^p_[a-f0-9]{16}$/.test(projectId)) throw new Error('Invalid projectId');
    const parent = await realpath(path.join(this.config.workspaceRoot, 'projects'));
    const candidate = path.join(parent, projectId);
    if ((await lstat(candidate)).isSymbolicLink()) throw new Error('Project directory cannot be a symbolic link');
    const directory = await realpath(candidate);
    if (path.dirname(directory) !== parent) throw new Error('Project directory is outside the workspace');
    return directory;
  }

  async load(projectId) {
    const directory = await this.directory(projectId);
    const metadataFile = path.join(directory, 'project.json');
    if ((await lstat(metadataFile)).isSymbolicLink()) throw new Error('Project metadata cannot be a symbolic link');
    const value = await readJSON(metadataFile);
    if (value.id !== projectId || value.schemaVersion !== 1) throw new Error('Invalid project metadata');
    return { ...value, directory };
  }

  async create(targetPath, goal, label, targetUrl) {
    const target = targetUrl ? inspectWebsite(targetUrl) : await inspectTarget(targetPath);
    const root = await prepareWorkspace(this.config);
    const id = 'p_' + randomUUID().replaceAll('-', '').slice(0, 16);
    const directory = path.join(root, 'projects', id);
    await mkdir(path.join(directory, 'evidence'), { recursive: true });
    await mkdir(path.join(directory, 'reports'));
    const value = { schemaVersion: 1, id, label: label || (targetUrl ? new URL(targetUrl).hostname : path.basename(target.targetPath)), goal,
      createdAt: new Date().toISOString(), state: 'open', target, evidence: [], findings: [], runs: [] };
    await atomicJSON(path.join(directory, 'project.json'), value);
    return { ...value, directory };
  }

  async mutate(projectId, operation) {
    const previous = this.#locks.get(projectId) || Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      const project = await this.load(projectId);
      const result = await operation(project);
      const { directory, ...value } = project;
      await atomicJSON(path.join(directory, 'project.json'), value);
      return result;
    });
    this.#locks.set(projectId, pending);
    try { return await pending; } finally { if (this.#locks.get(projectId) === pending) this.#locks.delete(projectId); }
  }

  async addEvidence(projectId, { payload, kind, description, sourcePath = null, sourceSha256 = null, run = null }) {
    return this.mutate(projectId, async project => {
      if (project.state !== 'open') throw new Error('Project is closed');
      const id = 'e_' + randomUUID().replaceAll('-', '').slice(0, 16);
      const relativePath = `evidence/${id}.txt`;
      const safePayload = redact(typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2));
      await writeFile(await ownedFile(project.directory, relativePath), safePayload, { flag: 'wx', mode: 0o600 });
      const evidence = { id, kind, description, sourcePath, sourceSha256,
        sha256: createHash('sha256').update(safePayload).digest('hex'), relativePath,
        sizeBytes: Buffer.byteLength(safePayload), totalCharacters: safePayload.length,
        createdAt: new Date().toISOString(), redaction: 'Common credential patterns filtered; review before sharing.' };
      project.evidence.push(evidence);
      if (run) project.runs.push({ ...run, evidenceId: id });
      return evidence;
    });
  }

  async readEvidence(projectId, evidenceId, offset = 0, limit = 16000) {
    const project = await this.load(projectId);
    const evidence = project.evidence.find(item => item.id === evidenceId);
    if (!evidence || evidence.relativePath !== `evidence/${evidenceId}.txt`) throw new Error('Unknown evidenceId');
    const file = await ownedFile(project.directory, evidence.relativePath);
    const hash = createHash('sha256'), decoder = new TextDecoder('utf-8', { fatal: true });
    let totalCharacters = 0, text = '';
    const select = chunk => {
      const start = Math.max(0, offset - totalCharacters), end = Math.min(chunk.length, offset + limit - totalCharacters);
      if (end > start) text += chunk.slice(start, end);
      totalCharacters += chunk.length;
    };
    for await (const chunk of createReadStream(file)) { hash.update(chunk); select(decoder.decode(chunk, { stream: true })); }
    select(decoder.decode());
    if (hash.digest('hex') !== evidence.sha256) throw new Error('Evidence digest mismatch');
    return { evidence, offset, totalCharacters, text, nextOffset: offset + limit < totalCharacters ? offset + limit : null };
  }

  async recordFinding(projectId, { statement, level, evidenceIds, limitations = '', auth = null }) {
    return this.mutate(projectId, project => {
      if (project.state !== 'open') throw new Error('Project is closed');
      if (!LEVELS.includes(level)) throw new Error('Invalid finding level');
      const evidence = evidenceIds.map(id => project.evidence.find(item => item.id === id));
      if (evidence.some(item => !item)) throw new Error('Finding references unknown evidence');
      if (level !== 'unknown' && evidence.length === 0) throw new Error('A supported finding must reference evidence');
      if (level === 'live_verified' && !evidence.some(item => ['runtime', 'network_capture'].includes(item.kind))) {
        throw new Error('live_verified requires runtime or network_capture evidence; static analysis is insufficient');
      }
      const finding = { id: 'f_' + randomUUID().replaceAll('-', '').slice(0, 16), statement: redact(statement), level,
        evidenceIds, limitations: redact(limitations), recordedAt: new Date().toISOString() };
      if (auth) finding.auth = JSON.parse(redact(JSON.stringify(auth)));
      project.findings.push(finding);
      return finding;
    });
  }

  async close(projectId) {
    return this.mutate(projectId, project => { project.state = 'closed'; project.closedAt = new Date().toISOString(); return { projectId, state: project.state }; });
  }

  async report(projectId) {
    const project = await this.load(projectId);
    const escape = value => String(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const lines = [`# ${escape(project.label)} — 软件分析报告`, '', `目标：${escape(project.target.targetPath)}`, '',
      `问题：${escape(project.goal)}`, '', `项目：${project.id}；状态：${project.state}`, '',
      `初步类型：${project.target.type}`, '', `SHA-256：${project.target.sha256 || '目录目标；未计算递归内容摘要'}`, '',
      '## 结论', '', ...project.findings.flatMap(item => [
        `- **${item.level}**：${escape(item.statement)}`, `  - 证据：${item.evidenceIds.join(', ') || '无'}`,
        `  - 限制：${escape(item.limitations) || '未单独说明'}`,
      ]), ...(project.findings.length ? [] : ['尚未记录结论；完成工具调用不等于验证了业务行为。']), '',
      '## 分析运行', '', ...project.runs.map(run => `- ${run.profile}：${run.status}；证据 ${run.evidenceId}；${run.createdAt}`), '',
      '## 认证与 token', '', ...project.findings.filter(item => item.auth).map(item => `- ${item.auth.mechanism} / ${item.level}：${escape(item.statement)}；来源 ${item.auth.tokenSource}；有效期 ${item.auth.expiresSeconds ?? '未知'} 秒；续期 ${escape(item.auth.renewal || '未知')}；验证范围 ${escape(item.auth.verifiedScope)}`), '',
      '## 证据', '', ...project.evidence.map(item => `- [${item.id}](../${item.relativePath}) — ${escape(item.description)}；SHA-256 ${item.sha256}`), '',
      '## 范围与限制', '', ...project.target.limitations.map(item => `- ${escape(item)}`),
      '- observed 表示已观察到材料中的事实；static_inference 表示代码推断；live_verified 表示记录者引用了运行材料，并不由报告工具独立认定验证充分；unknown 表示尚未确认。',
      '- 常见凭据字段已过滤；过滤器不能识别所有秘密。原始资料、证据与报告不属于插件发布包。', ''];
    const reportPath = await ownedFile(project.directory, path.join('reports', 'analysis.md'));
    await writeFile(reportPath, redact(lines.join('\n')), { mode: 0o600 });
    return { projectId, reportPath, findingCount: project.findings.length, evidenceCount: project.evidence.length };
  }
}
