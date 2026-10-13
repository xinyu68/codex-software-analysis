import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { exists, ROOT, runtimeBase, reaEnvironment } from './config.mjs';
import { ReaSession } from './rea-session.mjs';

export const ENV_PROFILES = ['basic', 'web', 'android', 'android-runtime', 'flutter', 'native'];
export const JADX = Object.freeze({ version: '0.7.1',
  sha256: '6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75',
  url: 'https://github.com/1013503897/jadx-headless-mcp/releases/download/v0.7.1/jadx-headless-mcp-0.7.1-all.jar' });

export function supportedNode(version) {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
  return major === 22 && minor >= 19 || major === 24 && minor >= 11 || major >= 26;
}
export function fullJdkModules(text) { return Number(text.match(/^java\.base@(\d+)/m)?.[1]) >= 17 && /^jdk\.compiler@/m.test(text); }

export async function digest(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }

export async function findBrowser(config) {
  const candidates = config.browserExecutable ? [config.browserExecutable] : process.platform === 'win32' ? [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ] : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'] : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
  for (const candidate of candidates.filter(Boolean)) if (await exists(candidate)) return candidate;
  return null;
}

async function selectJdk(config, jobs, signal) {
  const candidates = [config.javaHome, ...(process.env.PATH || '').split(path.delimiter).filter(part => /(?:^|[\\/])bin$/i.test(part)).map(part => path.dirname(part))].filter(Boolean);
  for (const root of [...new Set(candidates)]) {
    const java = path.join(root, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    const compiler = path.join(root, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac');
    if (!await exists(java) || !await exists(compiler)) continue;
    const checked = await jobs.run('environment', java, ['--list-modules'], { signal, timeoutMs: 10000 });
    if (checked.exitCode === 0 && fullJdkModules(checked.stdout)) return root;
  }
  return null;
}

export async function checkEnvironment(config, profile, jobs, signal, probe = true) {
  if (!ENV_PROFILES.includes(profile)) throw new Error('Unknown environment profile');
  const items = [{ name: 'node', state: supportedNode(process.version) ? 'available' : 'unsupported', version: process.version }];
  items.push({ name: 'rea', state: config.rea?.version === '6.4.0' ? 'available' : config.rea ? 'unsupported' : 'missing', version: config.rea?.version || null, expectedVersion: '6.4.0' });
  if (config.rea && probe) {
    const session = new ReaSession(config);
    try {
      await session.open(signal);
      const tools = (await session.client.listTools({}, { signal, timeout: 20000 })).tools;
      const required = profile === 'web' ? ['capture_browser_scenario', 'export_evidence_bundle', 'export_web_scripts'] : profile === 'android' ? ['inspect_android_package'] : [];
      items.push({ name: 'rea-mcp', state: required.every(name => tools.some(tool => tool.name === name)) ? 'verified' : 'unsupported', toolCount: tools.length, required });
    } catch (error) { items.push({ name: 'rea-mcp', state: 'failed', reason: error.message }); }
    finally { await session.close(); }
  }
  if (profile === 'web') items.push({ name: 'browser', state: await findBrowser(config) ? 'available' : 'missing', path: await findBrowser(config), verification: 'Executable exists; a local fixture capture verifies the engine.' });
  if (['android', 'android-runtime', 'flutter'].includes(profile)) {
    if (probe) config.javaHome = await selectJdk(config, jobs, signal) || config.javaHome;
    const java = config.javaHome && path.join(config.javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    const compiler = config.javaHome && path.join(config.javaHome, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac');
    const jdk = { name: 'jdk', state: await exists(java) && await exists(compiler) ? 'available' : 'missing', path: config.javaHome || null };
    if (jdk.state === 'available' && probe) {
      const result = await jobs.run('environment', java, ['--list-modules'], { signal, timeoutMs: 15000, env: reaEnvironment(config) });
      jdk.state = result.exitCode === 0 && fullJdkModules(result.stdout) ? 'verified' : 'unsupported';
      jdk.reason = jdk.state === 'verified' ? 'Full modular JDK including jdk.compiler' : 'Select a full JDK 17+ for this analysis process';
    }
    items.push(jdk);
    items.push({ name: 'jadx', state: await exists(config.jadxJar) ? await digest(config.jadxJar) === JADX.sha256 ? 'verified' : 'unverified' : 'missing', path: config.jadxJar || null, expectedVersion: JADX.version });
  }
  if (profile === 'android-runtime') {
    const adb = config.androidSdkRoot && path.join(config.androidSdkRoot, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
    const item = { name: 'adb', state: await exists(adb) ? 'available' : 'missing', path: adb };
    if (item.state === 'available' && probe) {
      const result = await jobs.run('environment', adb, ['version'], { signal, timeoutMs: 10000 });
      item.state = result.exitCode === 0 ? 'verified' : 'failed'; item.version = result.stdout.trim();
    }
    items.push(item, { name: 'selected-device', state: 'task-dependent', reason: 'Select an existing phone or a separate AVD when the task needs runtime observation; no device or adb server was started.' });
  }
  if (profile === 'flutter') items.push({ name: 'flutter-aot', state: 'task-dependent', path: config.blutterRoot || null, reason: 'Select tools after checking the APK ABI and Dart/engine version; Blutter is optional.' });
  if (profile === 'native') items.push({ name: 'native-provider', state: config.ghidraRoot && await exists(config.ghidraRoot) ? 'available' : 'task-dependent', path: config.ghidraRoot || null, reason: 'Choose a compatible provider for the format, OS and requested depth.' });
  const missing = items.filter(item => ['missing', 'unsupported', 'failed', 'unverified'].includes(item.state)).map(item => item.name);
  return { profile, checkedAt: new Date().toISOString(), ready: missing.length === 0, missing, items,
    installable: missing.filter(name => ['rea', 'jadx', 'jdk'].includes(name)),
    nextSteps: missing.length ? ['Run the setup skill or scripts/prepare-environment.mjs for only the missing components.'] : ['Use a learning fixture or the requested target to validate the actual provider.'],
    limitations: ['Version/engine checks do not prove every target can be analyzed. Runtime devices and format-specific tools remain task-dependent.'] };
}

export async function npmEntry(env = process.env) {
  const candidates = [env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), env.APPDATA && path.join(env.APPDATA, 'npm/node_modules/npm/bin/npm-cli.js')];
  for (const candidate of candidates.filter(Boolean)) if (path.basename(candidate) === 'npm-cli.js' && await exists(candidate)) return candidate;
  throw new Error('npm-cli.js is missing; use a Node distribution with npm');
}

async function download(url, file, expected, signal) {
  let response;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { response = await fetch(url, { signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(600000)]) }); break; }
    catch (error) { if (signal?.aborted || attempt === 1) throw new Error(`Dependency download failed from ${new URL(url).hostname}: ${error.cause?.code || error.message}`); }
  }
  if (!response.ok || !response.url.startsWith('https://')) throw new Error(`Download failed (${response.status})`);
  const handle = await import('node:fs/promises').then(fs => fs.open(file, 'wx', 0o600));
  let bytes = 0;
  try { for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 384 * 1024 * 1024) throw new Error('Download exceeds 384 MiB'); await handle.write(chunk); } }
  finally { await handle.close(); }
  if (await digest(file) !== expected) throw new Error('Downloaded dependency SHA-256 does not match the selected release');
}

export async function prepareEnvironment(config, { components = [], install = false }, jobs, signal) {
  if (components.some(name => !['rea', 'jadx', 'jdk'].includes(name))) throw new Error('Unsupported dependency component');
  if (!install) return { installed: [], plan: components, scope: 'Managed local runtime only', sources: { rea: 'rea-agents@6.4.0', jadx: JADX.url, jdk: 'Eclipse Temurin 21 portable JDK; Windows x64' } };
  const base = runtimeBase();
  const managed = path.join(base, 'tools');
  await mkdir(managed, { recursive: true });
  const installed = [], binding = {};
  for (const name of [...new Set(components)]) {
    signal?.throwIfAborted();
    if (name === 'rea') {
      if (config.rea?.version === '6.4.0') { installed.push({ name, state: 'reused' }); continue; }
      const directory = path.join(managed, 'rea-6.4.0');
      await mkdir(directory, { recursive: true });
      const result = await jobs.run('environment', process.execPath, [await npmEntry(), 'install', '--prefix', directory, '--ignore-scripts', '--no-audit', '--no-fund', 'rea-agents@6.4.0'], { signal, timeoutMs: 600000 });
      if (result.exitCode !== 0 || result.termination) throw new Error(`REA installation failed: ${result.termination || result.stderr.slice(-1000)}`);
      binding.reaRoot = path.join(directory, 'node_modules', 'rea-agents');
      config.rea = { root: binding.reaRoot, entry: path.join(binding.reaRoot, 'scripts', 'rea.mjs'), version: '6.4.0' };
    } else if (name === 'jadx') {
      if (config.jadxJar && await exists(config.jadxJar) && await digest(config.jadxJar) === JADX.sha256) { installed.push({ name, state: 'reused' }); continue; }
      const file = path.join(managed, 'jadx-headless-mcp-0.7.1-all.jar');
      if (!await exists(file)) { const temporary = file + '.' + randomUUID() + '.part'; await download(JADX.url, temporary, JADX.sha256, signal); await rename(temporary, file); }
      if (await digest(file) !== JADX.sha256) throw new Error('Existing managed JADX JAR has changed');
      binding.jadxJar = config.jadxJar = file;
    } else {
      const java = config.javaHome && path.join(config.javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
      if (java && await exists(java)) {
        const checked = await jobs.run('environment', java, ['--list-modules'], { signal, timeoutMs: 15000 });
        if (checked.exitCode === 0 && fullJdkModules(checked.stdout)) { installed.push({ name, state: 'reused' }); continue; }
      }
      if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Portable JDK setup currently supports Windows x64; follow the platform guide');
      const response = await fetch('https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jdk&os=windows', { signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(30000)]) });
      if (!response.ok) throw new Error(`Temurin release lookup failed (${response.status})`);
      const release = (await response.json())[0];
      const pkg = release?.binary?.package;
      if (!pkg || !/^https:\/\/github\.com\/adoptium\/temurin21-binaries\/releases\/download\//.test(pkg.link) || !/^[a-f0-9]{64}$/.test(pkg.checksum)) throw new Error('Unexpected Temurin release metadata');
      const directory = path.join(managed, 'jdk-' + pkg.checksum.slice(0, 16));
      if (!await exists(path.join(directory, 'ready.json'))) {
        const archive = path.join(managed, 'temurin-' + randomUUID() + '.zip');
        await download(pkg.link, archive, pkg.checksum, signal);
        const result = await jobs.run('environment', path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-File', path.join(ROOT, 'scripts/extract-zip.ps1'), '-Archive', archive, '-Destination', directory, '-ManagedRoot', managed], { signal, timeoutMs: 120000 });
        if (result.exitCode !== 0 || result.termination) throw new Error('Portable JDK extraction failed');
        const directories = await import('node:fs/promises').then(fs => fs.readdir(directory, { withFileTypes: true }));
        const root = directories.find(item => item.isDirectory() && item.name.startsWith('jdk-'));
        if (!root) throw new Error('Portable JDK root not found');
        await writeFile(path.join(directory, 'ready.json'), JSON.stringify({ javaHome: path.join(directory, root.name), source: pkg.link, sha256: pkg.checksum }));
      }
      binding.javaHome = config.javaHome = JSON.parse(await readFile(path.join(directory, 'ready.json'), 'utf8')).javaHome;
    }
    installed.push({ name, state: 'prepared' });
  }
  const file = path.join(base, 'binding.json');
  const previous = await exists(file) ? JSON.parse(await readFile(file, 'utf8')) : {};
  const temporary = file + '.' + randomUUID() + '.tmp';
  const selected = Object.fromEntries(['javaHome', 'jadxJar', 'browserExecutable'].filter(key => config[key]).map(key => [key, config[key]]));
  await writeFile(temporary, JSON.stringify({ ...previous, ...selected, ...binding }, null, 2), { mode: 0o600 });
  await rename(temporary, file);
  return { installed, binding, nextStep: 'Run analysis_check_environment; reconnect REA MCP after changing engine paths.', globalEnvironmentChanged: false };
}
