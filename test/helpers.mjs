import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AnalysisService } from '../lib/service.mjs';

export async function workspace(test) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'software-analysis-test-'));
  test.after(async () => {
    const absolute = path.resolve(root);
    assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
    assert.ok(path.basename(absolute).startsWith('software-analysis-test-'));
    await rm(absolute, { recursive: true, force: true });
  });
  const target = path.join(root, 'sample.mjs');
  await writeFile(target, 'export const example = 1;\n');
  const service = new AnalysisService({ rea: null, workspaceRoot: path.join(root, 'workspace'), androidSdkRoot: null });
  test.after(() => service.shutdown());
  return { root, target, service };
}
