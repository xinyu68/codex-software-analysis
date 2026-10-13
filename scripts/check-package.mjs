import assert from 'node:assert/strict';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, readJSON } from '../lib/config.mjs';

const manifest = await readJSON(path.join(ROOT, 'plugin.json'));
const pkg = await readJSON(path.join(ROOT, 'package.json'));
assert.equal(manifest.name, pkg.name);
assert.equal(manifest.version, pkg.version);
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
assert.ok(manifest.extensions['com.openai'].interface.shortDescription.length <= 30);
for (const banned of ['skills', 'mcpServers', 'apps', 'interface']) assert.ok(!(banned in manifest));
const mcp = await readJSON(path.join(ROOT, 'mcp.json'));
for (const server of Object.values(mcp.mcpServers)) {
  assert.equal(server.type, 'stdio');
  assert.equal(server.command, 'node');
  assert.equal(server.cwd, './');
  for (const relative of server.args.filter(item => item !== 'rea')) {
    assert.ok(relative.startsWith('./') && !relative.includes('..'));
    assert.ok((await lstat(path.join(ROOT, relative))).isFile());
  }
}
for (const name of await readdir(path.join(ROOT, 'skills'))) {
  const text = await readFile(path.join(ROOT, 'skills', name, 'SKILL.md'), 'utf8');
  assert.ok(text.startsWith(`---\nname: ${name}\n`));
  assert.match(text, /\ndescription: .+\n/);
}
for (const file of [manifest.extensions['com.openai'].onboardingSkill, manifest.extensions['com.openai'].interface.logo]) {
  assert.ok(file.startsWith('./') && !file.includes('..'));
  assert.ok((await lstat(path.join(ROOT, file))).isFile());
}
console.log('Package structure, manifests, MCP entrypoints and skill metadata verified');
