import { ReaSession } from './rea-session.mjs';
import { ROOT, runtimeBase } from './config.mjs';

export async function diagnoseConnections(config, signal) {
  const probes = [{ mode: 'orchestration', required: ['analysis_status', 'analysis_inspect_local', 'analysis_cleanup_artifacts'] },
    { mode: 'rea', required: ['open_binary', 'inspect_artifact', 'analyze_function'] }];
  const entrypoints = await Promise.all(probes.map(async ({ mode, required }) => {
    if (mode === 'rea' && !config.rea) return { mode, state: 'missing', required, missingTools: required };
    const session = new ReaSession(config, mode);
    try {
      await session.open(signal);
      const tools = (await session.client.listTools({}, { signal, timeout: 20000 })).tools;
      const names = tools.map(tool => tool.name), missingTools = required.filter(name => !names.includes(name));
      return { mode, state: missingTools.length ? 'unsupported' : 'verified', server: session.client.getServerVersion(),
        toolCount: names.length, required, missingTools, toolSample: names.slice(0, 20) };
    } catch (error) { return { mode, state: 'failed', reason: error.message, required }; }
    finally { await session.close(); }
  }));
  return { checkedAt: new Date().toISOString(), sourceRoot: ROOT, runtimeBase: runtimeBase(), workspaceRoot: config.workspaceRoot,
    reaVersion: config.rea?.version || null, entrypoints, ready: entrypoints.every(entry => entry.state === 'verified'),
    hostToolExposure: 'not_verified',
    limitations: ['These are fresh local MCP initialization and tool-discovery probes. They cannot establish which tools the current chat host exposes.',
      'No target app, device, browser or remote business API was opened. Restart/reload the host when its tool catalog is stale.'] };
}
