import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, exists, loadConfig } from '../lib/config.mjs';

export const RUNTIME_FILES = Object.freeze(['package.json', 'package-lock.json', 'lib/config.mjs', 'lib/target.mjs', 'lib/jobs.mjs', 'lib/projects.mjs', 'lib/service.mjs',
  'lib/operations.mjs', 'lib/rea-session.mjs', 'lib/environment.mjs', 'lib/web.mjs',
  'mcp/server.mjs', 'mcp/tools.mjs', 'scripts/cli.mjs', 'scripts/rea-mcp.mjs', 'scripts/extract-zip.ps1']);

export async function ensureRuntime({ env = process.env, install = false } = {}) {
  const config = await loadConfig(env);
  const files = RUNTIME_FILES;
  const binding = { workspaceRoot: config.workspaceRoot,
    ...(config.rea ? { reaRoot: config.rea.root } : {}),
    ...(config.androidSdkRoot ? { androidSdkRoot: config.androidSdkRoot } : {}),
    ...Object.fromEntries(['javaHome', 'jadxJar', 'browserExecutable', 'ghidraRoot', 'blutterRoot'].filter(key => config[key]).map(key => [key, config[key]])) };
  const hash = createHash('sha256').update(JSON.stringify(binding));
  for (const file of files) hash.update(file).update(await readFile(path.join(ROOT, file)));
  const base = env.SOFTWARE_ANALYSIS_RUNTIME_HOME || path.join(env.LOCALAPPDATA || path.join(homedir(), '.local', 'share'), 'codex-software-analysis', 'runtime');
  if (!path.isAbsolute(base)) throw new Error('SOFTWARE_ANALYSIS_RUNTIME_HOME must be absolute');
  const directory = path.join(base, hash.digest('hex').slice(0, 20));
  const marker = path.join(directory, 'ready.json');
  if (await exists(marker)) return { directory, prepared: true, installedDependencies: false };
  if (!install) throw new Error('Plugin runtime is not prepared. Run node scripts/runtime.mjs setup from the plugin source, then reconnect.');
  // Different source/configuration snapshots use different directories; running MCPs are not overwritten.
  await mkdir(directory, { recursive: true });
  for (const file of files) {
    const destination = path.join(directory, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(ROOT, file), destination);
  }
  await mkdir(path.join(directory, 'config'), { recursive: true });
  await writeFile(path.join(directory, 'config', 'local.json'), JSON.stringify(binding, null, 2));
  const npmCandidates = [env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    env.APPDATA && path.join(env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js')].filter(Boolean);
  let npmEntry = null;
  for (const candidate of npmCandidates) if (await exists(candidate) && path.basename(candidate) === 'npm-cli.js') { npmEntry = candidate; break; }
  if (!npmEntry) throw new Error('npm-cli.js was not found. Run setup through npm run setup or use a Node distribution with npm.');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npmEntry, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: directory, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => process.stderr.write(chunk));
    child.stderr.on('data', chunk => process.stderr.write(chunk));
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`Runtime dependency install failed (${code})`)));
  });
  const temporaryBinding = path.join(base, 'binding.' + process.pid + '.' + Date.now() + '.tmp');
  await writeFile(temporaryBinding, JSON.stringify(binding, null, 2));
  await rename(temporaryBinding, path.join(base, 'binding.json'));
  await writeFile(marker, JSON.stringify({ preparedAt: new Date().toISOString(), source: ROOT, binding }, null, 2));
  return { directory, prepared: true, installedDependencies: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] !== 'setup') throw new Error('Usage: node scripts/runtime.mjs setup');
    console.log(JSON.stringify(await ensureRuntime({ install: true }), null, 2));
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
