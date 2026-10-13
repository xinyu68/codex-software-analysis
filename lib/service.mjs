import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { exists, loadConfig, reaEnvironment, VERSION } from './config.mjs';
import { JobManager } from './jobs.mjs';
import { ProjectStore } from './projects.mjs';
import { inspectTarget } from './target.mjs';
import { OwnedOperations } from './operations.mjs';
import { checkEnvironment, prepareEnvironment } from './environment.mjs';
import { captureWebsite, privateArea } from './web.mjs';
import { ReaSession } from './rea-session.mjs';

export const PROFILES = ['artifact', 'android', 'javascript', 'managed', 'har'];
const commands = { artifact: 'inspect-artifact', android: 'inspect-android-package', javascript: 'analyze-javascript-application',
  managed: 'inspect-managed-artifact', har: 'inspect-web-network-capture' };

export class AnalysisService {
  constructor(config, jobs = new JobManager()) { this.config = config; this.jobs = jobs; this.projects = new ProjectStore(config); this.operations = new OwnedOperations(); }
  static async create() { return new AnalysisService(await loadConfig()); }

  async status() {
    const sdk = this.config.androidSdkRoot;
    const suffix = process.platform === 'win32' ? '.exe' : '';
    return { version: VERSION, platform: process.platform, nodeVersion: process.version,
      workspaceRoot: this.config.workspaceRoot, rea: this.config.rea || { installed: false, remediation: 'Install rea-agents or configure SOFTWARE_ANALYSIS_REA_ROOT' },
      android: { sdkRoot: sdk, adbPresent: await exists(sdk && path.join(sdk, 'platform-tools', 'adb' + suffix)),
        emulatorPresent: await exists(sdk && path.join(sdk, 'emulator', 'emulator' + suffix)) },
      activeJobs: this.jobs.list(), activeOperations: this.operations.list(), profiles: [...PROFILES, 'web'],
      enginePaths: { javaHome: this.config.javaHome || null, jadxJar: this.config.jadxJar || null, browserExecutable: this.config.browserExecutable || null },
      limitations: ['Installed packages do not establish provider readiness. Native/JADX workflows require their own compatible engines.',
        'No target, device, browser, emulator, or remote business API was contacted by this status check.'] };
  }

  async runStatic({ projectId, profile, timeoutSeconds = 90 }, signal) {
    if (!PROFILES.includes(profile)) throw new Error('Unknown static profile');
    const project = await this.projects.load(projectId);
    if (project.state !== 'open') throw new Error('Project is closed');
    if (!this.config.rea) throw new Error('REA is not installed; run the setup skill');
    const website = project.target.type === 'website';
    const exported = website && project.runs.filter(run => run.profile === 'web' && run.scriptsInput).at(-1)?.scriptsInput.input_path;
    if (website && (profile !== 'javascript' || !exported)) throw new Error('Capture the website first, then use the javascript profile for its exported scripts');
    const target = await inspectTarget(website ? exported : project.target.targetPath);
    if (!website && (target.sha256 !== project.target.sha256 || target.type !== project.target.type)) throw new Error('Target changed; create a new analysis project');
    if (website && (!target.targetPath.startsWith(project.directory + path.sep) || !target.targetPath.includes(path.sep + 'artifacts' + path.sep))) throw new Error('Exported scripts must stay inside the project');
    if (website) return this.operations.run(projectId, 'website-script-analysis', next => this.analyzeWebsiteScripts(project, target, timeoutSeconds, next), signal);
    const args = [this.config.rea.entry, commands[profile], target.targetPath];
    if (profile === 'har') args.push('har');
    if (profile === 'javascript') args.push('--analysis-timeout-ms', String(Math.max(1000, timeoutSeconds * 1000 - 2000)));
    args.push('--format', 'json', '--full-output');
    const result = await this.jobs.run(projectId, process.execPath, args, { timeoutMs: timeoutSeconds * 1000, signal, env: reaEnvironment(this.config) });
    let provider = null;
    try { provider = JSON.parse(result.stdout); } catch {}
    const data = provider?.data || provider?.result || provider;
    const error = data?.error || (data?.code && !data?.evidence_id);
    const status = result.termination || (result.exitCode === 0 && provider && !error ? 'completed' : 'failed');
    // A close request may have cancelled the job while the process was running.
    if ((await this.projects.load(projectId)).state !== 'open') return { projectId, jobId: result.jobId, status: 'cancelled', evidenceId: null };
    const evidence = await this.projects.addEvidence(projectId, { payload: { command: commands[profile], ...result, provider },
      kind: 'static', description: `REA ${commands[profile]} — ${status}`, sourcePath: target.targetPath, sourceSha256: target.sha256,
      run: { jobId: result.jobId, profile, status, createdAt: new Date().toISOString() } });
    return { projectId, jobId: result.jobId, profile, status, evidenceId: evidence.id,
      providerEvidenceId: data?.evidence_id || null, providerErrorCode: error ? data.error?.code || data.code : null,
      resultFile: path.join(project.directory, evidence.relativePath),
      nextStep: 'Read evidence with analysis_read_evidence, then record only supported findings. Static results do not prove live API behavior.' };
  }

  async importEvidence({ projectId, sourcePath, kind, description }) {
    if (!path.isAbsolute(sourcePath)) throw new Error('sourcePath must be an absolute local path');
    const info = await stat(sourcePath);
    if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error('Import a regular text evidence file no larger than 64 MiB; split larger records');
    const bytes = await readFile(sourcePath);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return this.projects.addEvidence(projectId, { payload: text, kind, description, sourcePath,
      sourceSha256: createHash('sha256').update(bytes).digest('hex') });
  }

  async close(projectId) {
    await this.projects.load(projectId);
    const operations = await this.operations.stop(projectId);
    const processes = await this.jobs.stop(projectId);
    const project = await this.projects.close(projectId);
    return { ...project, processes, operations,
      limitations: ['Owned website REA sessions and bootstrap listeners are closed. External rea_analysis sessions, apps and emulators remain with their original owner.'] };
  }

  async checkEnvironment({ profile = 'basic' }, signal) { return this.operations.run('environment', 'environment-check', next => checkEnvironment(this.config, profile, this.jobs, next), signal); }
  async prepareEnvironment(args, signal) { return this.operations.run('environment', 'environment-setup', next => prepareEnvironment(this.config, args, this.jobs, next), signal); }
  async captureWebsite(args, signal) { return this.operations.run(args.projectId, 'website-capture', next => captureWebsite(this, args, next), signal); }
  async shutdown() { await Promise.all([this.operations.shutdown(), this.jobs.shutdown()]); }

  async analyzeWebsiteScripts(project, target, timeoutSeconds, signal) {
    const session = new ReaSession(this.config);
    try {
      await session.open(signal);
      const summary = await session.call('analyze_javascript_application', { input_path: target.targetPath, format: 'directory', detail: 'summary', analysis_timeout_ms: Math.max(1000, timeoutSeconds * 1000 - 2000) }, signal, timeoutSeconds * 1000);
      const rawPath = path.join(await privateArea(project.directory), randomUUID() + '-javascript.private.json');
      await session.call('export_evidence_bundle', { path: rawPath }, signal, 60000);
      const evidence = await this.projects.addEvidence(project.id, { payload: summary, kind: 'static', description: 'REA 网站脚本静态分析摘要；完整会话证据保存在本地私有文件', sourcePath: rawPath,
        run: { profile: 'javascript', status: 'completed', createdAt: new Date().toISOString() } });
      return { projectId: project.id, profile: 'javascript', status: 'completed', evidenceId: evidence.id, providerEvidenceId: summary.evidence_id, rawAnalysisPath: rawPath,
        limitations: summary.normalized_result?.summary?.coverage || summary.limitations,
        nextStep: 'Read the summary and its coverage. A completed tool call does not imply complete semantic reconstruction.' };
    } finally { await session.close(); }
  }
}
