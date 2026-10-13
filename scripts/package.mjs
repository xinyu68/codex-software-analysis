import { spawn } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, readJSON } from '../lib/config.mjs';

const pkg = await readJSON(path.join(ROOT, 'package.json'));
const base = path.basename(ROOT);
const files = ['package.json', 'package-lock.json', 'plugin.json', 'mcp.json', '.gitignore', '.gitattributes', 'README.md', 'LICENSE', 'config/local.example.json'];
async function walk(relative) {
  const full = path.join(ROOT, relative);
  const info = await lstat(full);
  if (info.isSymbolicLink()) throw new Error(`Source package cannot include a symbolic link: ${relative}`);
  if (info.isDirectory()) {
    for (const name of await readdir(full)) {
      if (name === '.runtime' || name === 'node_modules' || name === '.git' || name === 'local.json' || name.includes('.private.') || name.startsWith('.env')) continue;
      await walk(path.join(relative, name));
    }
  } else if (info.isFile()) files.push(relative);
}
for (const folder of ['lib', 'mcp', 'scripts', 'skills', 'docs', 'test', 'assets', '.agents']) await walk(folder);
for (const file of files) {
  const normalized = path.relative(ROOT, path.resolve(ROOT, file));
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) throw new Error('Source file is outside the plugin');
  if ((await lstat(path.join(ROOT, file))).isSymbolicLink()) throw new Error('Source package cannot contain links');
}
const archive = path.join(path.dirname(ROOT), `${base}-${pkg.version}.tar.gz`);
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
await new Promise((resolve, reject) => {
  const child = spawn(tar, ['-czf', archive, ...files.sort().map(file => `${base}/${file.replaceAll('\\', '/')}`)], {
    cwd: path.dirname(ROOT), shell: false, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve() : reject(new Error(`Archive creation failed (${code})`)));
});
console.log(JSON.stringify({ archive, fileCount: files.length, excluded: ['node_modules', '.git', '.runtime', 'config/local.json', 'analysis workspace'] }, null, 2));
