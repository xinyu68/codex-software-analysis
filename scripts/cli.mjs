import { AnalysisService } from '../lib/service.mjs';
import { prepareWorkspace, readJSON } from '../lib/config.mjs';
import { callTool } from '../mcp/tools.mjs';

const service = await AnalysisService.create();
try {
  const [command = 'status', payload = '{}'] = process.argv.slice(2);
  let result;
  if (command === '--request') {
    const request = await readJSON(payload);
    result = await callTool(service, request.tool, request.arguments || {});
  } else if (command === 'setup') {
    await prepareWorkspace(service.config);
    result = { ...await service.status(), nextStep: 'Install this source plugin only when requested. Setup does not change Codex registration or download analysis engines.' };
  } else if (command === 'status') result = await service.status();
  else result = await callTool(service, command, JSON.parse(payload));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
} finally { await service.shutdown(); }
