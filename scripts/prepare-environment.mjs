import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { ensureRuntime } from './runtime.mjs';
import { loadConfig, exists, ROOT } from '../lib/config.mjs';

try {
  const [profile = 'basic', ...flags] = process.argv.slice(2);
  if (flags.some(flag => flag !== '--install')) throw new Error('Usage: node scripts/prepare-environment.mjs <profile> [--install]');
  const runtime = flags.includes('--install') ? await ensureRuntime({ install: true }) : await exists(path.join(ROOT, 'node_modules/@modelcontextprotocol/sdk')) ? { directory: ROOT } : await ensureRuntime({ install: false });
  const { checkEnvironment, prepareEnvironment } = await import(pathToFileURL(path.join(runtime.directory, 'lib/environment.mjs')));
  const { JobManager } = await import(pathToFileURL(path.join(runtime.directory, 'lib/jobs.mjs')));
  const jobs = new JobManager();
  try {
    const config = await loadConfig();
    const before = await checkEnvironment(config, profile, jobs);
    const preparation = await prepareEnvironment(config, { components: before.installable, install: flags.includes('--install') }, jobs);
    const after = flags.includes('--install') ? await checkEnvironment(config, profile, jobs) : null;
    console.log(JSON.stringify({ before, preparation, after }, null, 2));
  } finally { await jobs.shutdown(); }
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
