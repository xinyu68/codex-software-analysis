import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectPe, extractStrings, selectLocalFile } from '../lib/local-inspection.mjs';
import { callTool } from '../mcp/tools.mjs';
import { workspace } from './helpers.mjs';

export function peFixture(wide = true) {
  const b = Buffer.alloc(0x600), nt = 0x80, opt = nt + 24, optionalSize = wide ? 240 : 224;
  b.write('MZ'); b.writeUInt32LE(nt, 0x3c); b.write('PE\0\0', nt);
  b.writeUInt16LE(wide ? 0x8664 : 0x14c, nt + 4); b.writeUInt16LE(1, nt + 6); b.writeUInt16LE(optionalSize, nt + 20);
  b.writeUInt16LE(wide ? 0x20b : 0x10b, opt); b.writeUInt32LE(0x1000, opt + 16); b.writeUInt32LE(0x200, opt + 60); b.writeUInt16LE(2, opt + 68);
  b.writeUInt32LE(16, opt + (wide ? 108 : 92)); const dirs = opt + (wide ? 112 : 96);
  b.writeUInt32LE(0x1000, dirs + 8); b.writeUInt32LE(40, dirs + 12);
  const s = opt + optionalSize; b.write('.rdata', s); b.writeUInt32LE(0x400, s + 8); b.writeUInt32LE(0x1000, s + 12); b.writeUInt32LE(0x400, s + 16); b.writeUInt32LE(0x200, s + 20);
  b.writeUInt32LE(0x1060, 0x200); b.writeUInt32LE(0x1050, 0x20c); b.writeUInt32LE(0x1080, 0x210); b.write('KERNEL32.dll\0', 0x250);
  if (wide) { b.writeBigUInt64LE(0x10a0n, 0x260); b.writeBigUInt64LE(0x8000000000000007n, 0x268); }
  else { b.writeUInt32LE(0x10a0, 0x260); b.writeUInt32LE(0x80000007, 0x264); }
  b.write('CreateFileW\0', 0x2a2); return b;
}

test('bounded PE32 and PE32+ parsing returns named/ordinal imports without a provider', () => {
  for (const wide of [true, false]) {
    const result = inspectPe(peFixture(wide));
    assert.equal(result.architecture, wide ? 'x86_64' : 'x86');
    assert.deepEqual(result.imports, [{ library: 'KERNEL32.dll', symbols: [{ name: 'CreateFileW' }, { ordinal: 7 }] }]);
    assert.equal(result.embeddedSignature.trustVerification, 'not_performed');
    assert.equal(result.embeddedSignature.certificateTablePresent, false);
  }
  assert.equal(inspectPe(Buffer.from('plain file')), null);
  assert.throws(() => inspectPe(Buffer.from('MZ')), /outside/);
  const malformed = peFixture(); malformed.writeUInt32LE(0xfffffff0, 0x20c);
  assert.throws(() => inspectPe(malformed), /file backed/);
});

test('strings retain offsets and explicit truncation/encoding coverage', () => {
  const bytes = Buffer.concat([Buffer.from('hello\0world\0'), Buffer.from('wide text\0', 'utf16le')]);
  const result = extractStrings(bytes, 1);
  assert.equal(result.items[0].offset, 0);
  assert.equal(result.items[0].text, 'hello');
  assert.ok(result.omitted > 0);
  assert.match(result.coverage, /not all encodings/);
});

test('built-in local inspection works without REA and keeps the selected file unchanged', async t => {
  const { target, service } = await workspace(t);
  const before = await readFile(target);
  const project = await service.projects.create(target, 'Inspect a local fixture');
  const result = await callTool(service, 'analysis_inspect_local', { projectId: project.id });
  const evidence = await service.projects.readEvidence(project.id, result.evidenceId);
  assert.match(evidence.text, /execution-free-local-file-inspection/);
  assert.deepEqual(await readFile(target), before);
  assert.equal(service.config.rea, null);
  if (process.platform === 'win32') assert.equal(result.windowsStatus, 'completed');
});

test('directory file selection rejects traversal and junction escapes', async t => {
  const { root, service } = await workspace(t);
  const directory = path.join(root, 'target-dir'), outside = path.join(root, 'outside');
  await mkdir(directory); await mkdir(outside); await writeFile(path.join(outside, 'secret.txt'), 'not selected');
  const project = await service.projects.create(directory, 'File boundary');
  await assert.rejects(selectLocalFile(project, '../outside/secret.txt'), /outside/);
  await symlink(outside, path.join(directory, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(selectLocalFile(project, 'link/secret.txt'), /outside/);
});
