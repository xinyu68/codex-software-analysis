import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { readJSON } from './config.mjs';

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function inspectPE(handle, header) {
  if (header.length < 64) return 'native_pe';
  const peOffset = header.readUInt32LE(60);
  const pe = Buffer.alloc(264);
  const { bytesRead } = await handle.read(pe, 0, pe.length, peOffset);
  if (bytesRead < 24 || pe.toString('ascii', 0, 4) !== 'PE\0\0') return 'unknown_file';
  const magic = pe.readUInt16LE(24);
  const countOffset = magic === 0x20b ? 132 : 116;
  const clrOffset = magic === 0x20b ? 248 : 232;
  return bytesRead >= clrOffset + 8 && pe.readUInt32LE(countOffset) > 14 && pe.readUInt32LE(clrOffset) !== 0 ? 'managed_dotnet' : 'native_pe';
}

export async function inspectTarget(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.includes('\0')) throw new Error('targetPath must be an absolute local path');
  const targetPath = await realpath(input);
  const info = await lstat(targetPath);
  if (info.isDirectory()) {
    const entries = (await readdir(targetPath, { withFileTypes: true })).map(item => ({ name: item.name, kind: item.isSymbolicLink() ? 'link' : item.isDirectory() ? 'directory' : 'file' }));
    let pkg = null;
    try { pkg = await readJSON(path.join(targetPath, 'package.json')); } catch {}
    const electron = Boolean(pkg?.dependencies?.electron || pkg?.devDependencies?.electron || pkg?.build?.appId);
    return { targetPath, type: electron ? 'electron' : pkg ? 'javascript' : 'unknown_directory',
      classificationBasis: 'directory entry names and package.json; not executed',
      packageName: typeof pkg?.name === 'string' ? pkg.name : null,
      entries: entries.slice(0, 200), entryCount: entries.length, entriesTruncated: entries.length > 200,
      sha256: null, limitations: ['Directory identity is not a recursive content hash. Source changes must be considered when comparing runs.'] };
  }
  if (!info.isFile()) throw new Error('Target must be a regular file or directory');
  const handle = await open(targetPath, 'r');
  const header = Buffer.alloc(64);
  let type = 'unknown_file';
  try {
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const magic = header.subarray(0, bytesRead);
    const suffix = path.extname(targetPath).toLowerCase();
    if (magic.toString('ascii', 0, 2) === 'MZ') type = await inspectPE(handle, magic);
    else if (magic.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) type = 'native_elf';
    else if (suffix === '.class' && bytesRead >= 4 && magic.readUInt32BE(0) === 0xcafebabe) type = 'java_class';
    else if (bytesRead >= 4 && [0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic.readUInt32BE(0))) type = 'macho_or_universal';
    else if (magic.toString('ascii', 0, 2) === 'PK') type = suffix === '.apk' ? 'android_apk' : suffix === '.jar' ? 'java_archive' : 'archive';
    else if (suffix === '.asar') type = 'electron';
    else if (suffix === '.har') type = 'network_capture';
    else if (['.js', '.mjs', '.cjs', '.ts', '.py', '.java', '.dart'].includes(suffix)) type = 'source_file';
  } finally { await handle.close(); }
  return { targetPath, type, classificationBasis: 'file signature and filename; preliminary classification',
    sizeBytes: info.size, sha256: await sha256(targetPath), limitations: ['Classification is preliminary; provider evidence may refine it. No target code was executed.'] };
}

export function inspectWebsite(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error('targetUrl must be a complete HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use HTTP(S) without URL credentials');
  if ([...url.searchParams.keys()].some(key => /^(?:token|acs_token|access_token|refresh_token|password|api_key|secret)$/i.test(key))) throw new Error('Use a public target URL without credentials; do not put tokens in project metadata');
  if (/(?:^|[?&#])(?:token|acs_token|access_token|refresh_token|password|api_key|secret)=/i.test(url.hash)) throw new Error('Use a public target URL without credentials in its fragment');
  return { targetPath: url.href, targetUrl: url.href, type: 'website', sha256: null,
    classificationBasis: 'User-selected URL; not contacted during project creation',
    limitations: ['A URL is not an immutable software version. Capture time, final URL and script hashes identify each observation.'] };
}
