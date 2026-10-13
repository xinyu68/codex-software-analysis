import { access, mkdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const VERSION = '0.2.0';
export const CONFIG_KEYS = ['reaRoot', 'workspaceRoot', 'androidSdkRoot', 'browserExecutable', 'javaHome', 'jadxJar', 'ghidraRoot', 'blutterRoot'];

export function runtimeBase(env = process.env) {
  return env.SOFTWARE_ANALYSIS_RUNTIME_HOME || path.join(env.LOCALAPPDATA || path.join(homedir(), '.local', 'share'), 'codex-software-analysis', 'runtime');
}

export async function exists(file) {
  if (!file) return false;
  try { await access(file); return true; } catch { return false; }
}

export async function readJSON(file) {
  return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
}

export async function loadConfig(env = process.env) {
  let local = {};
  const configFile = path.join(ROOT, 'config', 'local.json');
  const base = runtimeBase(env);
  if (!path.isAbsolute(base)) throw new Error('SOFTWARE_ANALYSIS_RUNTIME_HOME must be absolute');
  for (const file of [path.join(base, 'binding.json'), configFile]) {
    if (await exists(file)) local = { ...local, ...await readJSON(file) };
  }
  for (const key of Object.keys(local)) {
    if (!CONFIG_KEYS.includes(key) || typeof local[key] !== 'string' || !path.isAbsolute(local[key])) {
      throw new Error(`Invalid local configuration field: ${key}; use an absolute path`);
    }
  }
  const configuredRoot = env.SOFTWARE_ANALYSIS_REA_ROOT || local.reaRoot;
  for (const value of [configuredRoot, env.SOFTWARE_ANALYSIS_HOME, env.SOFTWARE_ANALYSIS_ANDROID_SDK].filter(Boolean)) {
    if (!path.isAbsolute(value)) throw new Error('Software analysis environment paths must be absolute');
  }
  const candidates = configuredRoot ? [configuredRoot] : [
    path.join(ROOT, 'node_modules', 'rea-agents'),
    env.APPDATA && path.join(env.APPDATA, 'npm', 'node_modules', 'rea-agents'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/rea-agents'),
    '/usr/local/lib/node_modules/rea-agents',
    '/usr/lib/node_modules/rea-agents',
  ].filter(Boolean);
  let rea = null;
  for (const candidate of candidates) {
    if (await exists(path.join(candidate, 'scripts', 'rea.mjs'))) {
      const pkg = await readJSON(path.join(candidate, 'package.json'));
      if (pkg.name !== 'rea-agents') throw new Error('REA root must point to the rea-agents package');
      const root = await realpath(candidate);
      rea = { root, entry: path.join(root, 'scripts', 'rea.mjs'), version: pkg.version, engines: pkg.engines };
      break;
    }
  }
  const workspaceRoot = path.resolve(env.SOFTWARE_ANALYSIS_HOME || local.workspaceRoot ||
    path.join(env.LOCALAPPDATA || path.join(homedir(), '.local', 'share'), 'codex-software-analysis', 'workspace'));
  const sdkCandidates = [env.SOFTWARE_ANALYSIS_ANDROID_SDK, local.androidSdkRoot, env.ANDROID_SDK_ROOT, env.ANDROID_HOME,
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Android', 'Sdk')].filter(Boolean);
  const androidSdkRoot = (await Promise.all(sdkCandidates.map(async candidate => path.isAbsolute(candidate) && await exists(candidate) ? candidate : null))).find(Boolean) || sdkCandidates[0] || null;
  const tools = {};
  for (const [key, variable, fallback] of [
    ['browserExecutable', 'SOFTWARE_ANALYSIS_BROWSER', env.REA_BROWSER_EXECUTABLE],
    ['javaHome', 'SOFTWARE_ANALYSIS_JAVA_HOME', env.JAVA_HOME],
    ['jadxJar', 'SOFTWARE_ANALYSIS_JADX_JAR', env.REA_JADX_MCP_JAR],
    ['ghidraRoot', 'SOFTWARE_ANALYSIS_GHIDRA_ROOT', env.GHIDRA_INSTALL_DIR],
    ['blutterRoot', 'SOFTWARE_ANALYSIS_BLUTTER_ROOT', null],
  ]) {
    const value = env[variable] || local[key] || fallback || null;
    if (value && !path.isAbsolute(value)) throw new Error(`${variable} must be absolute`);
    tools[key] = value;
  }
  return { rea, workspaceRoot, androidSdkRoot, configFile, ...tools };
}

export function reaEnvironment(config, env = process.env) {
  const result = { ...env };
  if (config.javaHome) result.JAVA_HOME = config.javaHome;
  if (config.jadxJar) result.REA_JADX_MCP_JAR = config.jadxJar;
  if (config.browserExecutable) result.REA_BROWSER_EXECUTABLE = config.browserExecutable;
  if (config.ghidraRoot) result.GHIDRA_INSTALL_DIR = config.ghidraRoot;
  if (config.androidSdkRoot) {
    result.ANDROID_HOME = result.ANDROID_SDK_ROOT = config.androidSdkRoot;
    result.PATH = path.join(config.androidSdkRoot, 'platform-tools') + path.delimiter + (result.PATH || '');
  }
  return result;
}

export async function prepareWorkspace(config) {
  await mkdir(path.join(config.workspaceRoot, 'projects'), { recursive: true });
  return realpath(config.workspaceRoot);
}
