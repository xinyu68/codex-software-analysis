import { spawn } from 'node:child_process';
import path from 'node:path';
import { ensureRuntime } from './runtime.mjs';

try {
  const { directory } = await ensureRuntime();
  const mode = process.argv[2];
  if (mode && mode !== 'rea') throw new Error('Unknown MCP mode');
  const entry = mode === 'rea' ? path.join(directory, 'scripts', 'rea-mcp.mjs') : path.join(directory, 'mcp', 'server.mjs');
  const child = spawn(process.execPath, [entry], { windowsHide: true, shell: false, stdio: ['pipe', 'inherit', 'inherit'] });
  process.stdin.pipe(child.stdin);
  process.stdin.on('end', () => child.stdin.end());
  child.stdin.on('error', () => {});
  child.on('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
  child.on('close', code => { process.stdin.unpipe(child.stdin); process.stdin.pause(); process.exitCode = code ?? 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    process.stdin.unpipe(child.stdin); process.stdin.pause(); child.stdin.end();
  });
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
