import { spawn } from 'node:child_process';
import { loadConfig, reaEnvironment } from '../lib/config.mjs';
import { terminateOwnedChild } from '../lib/jobs.mjs';

const config = await loadConfig();
const { rea } = config;
if (!rea) {
  process.stderr.write('REA not found. Install rea-agents or set SOFTWARE_ANALYSIS_REA_ROOT, then reconnect.\n');
  process.exitCode = 1;
} else {
  const child = spawn(process.execPath, [rea.entry, '--mcp'], { env: reaEnvironment(config), stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true, shell: false, detached: process.platform !== 'win32' });
  const finished = new Promise(resolve => child.once('close', resolve));
  let closing;
  const close = () => closing ||= (async () => {
    process.stdin.unpipe(child.stdin); process.stdin.pause(); child.stdin.end();
    let timer;
    await Promise.race([finished, new Promise(resolve => { timer = setTimeout(resolve, 1000); })]);
    clearTimeout(timer);
    await terminateOwnedChild(child);
    await finished;
  })();
  // Pass MCP bytes unchanged. Closing stdin lets REA run its own session cleanup.
  process.stdin.pipe(child.stdin);
  process.stdin.on('end', () => { void close(); });
  child.stdin.on('error', () => {});
  child.on('error', error => { process.stderr.write(`REA startup failed: ${error.message}\n`); process.exitCode = 1; });
  child.on('close', (code, signal) => {
    process.stdin.unpipe(child.stdin);
    process.stdin.pause();
    process.exitCode = code ?? (signal ? 1 : 0);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    void close();
  });
}
