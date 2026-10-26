import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { inspectTarget } from './target.mjs';
import { ROOT } from './config.mjs';

const MAX_BYTES = 64 * 1024 * 1024;
function within(root, file) { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); }

export async function selectLocalFile(project, relativePath) {
  if (project.target.type === 'website') throw new Error('Select a local file project');
  const root = await realpath(project.target.targetPath);
  const info = await lstat(root);
  if (info.isFile()) {
    if (relativePath) throw new Error('relativePath applies only to directory projects');
    return root;
  }
  if (!info.isDirectory() || !relativePath || path.isAbsolute(relativePath)) throw new Error('A directory project requires a relativePath to one file');
  const candidate = await realpath(path.resolve(root, relativePath));
  if (!within(root, candidate) || !(await stat(candidate)).isFile()) throw new Error('Selected file is outside the target directory');
  return candidate;
}

export function inspectPe(bytes) {
  const need = (offset, length) => { if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > bytes.length) throw new Error('PE range outside the file'); };
  const u16 = offset => { need(offset, 2); return bytes.readUInt16LE(offset); };
  const u32 = offset => { need(offset, 4); return bytes.readUInt32LE(offset); };
  const u64 = offset => { need(offset, 8); return bytes.readBigUInt64LE(offset); };
  if (bytes.length < 2 || bytes.toString('ascii', 0, 2) !== 'MZ') return null;
  const nt = u32(0x3c); need(nt, 24);
  if (!bytes.subarray(nt, nt + 4).equals(Buffer.from([0x50, 0x45, 0, 0]))) throw new Error('MZ file has no valid PE signature');
  const count = u16(nt + 6), optionalSize = u16(nt + 20), opt = nt + 24;
  if (count < 1 || count > 96) throw new Error('PE section budget exceeded');
  need(opt, optionalSize);
  const magic = u16(opt), wide = magic === 0x20b;
  if (![0x10b, 0x20b].includes(magic) || optionalSize < (wide ? 112 : 96)) throw new Error('Unsupported PE optional header');
  const directories = opt + (wide ? 112 : 96), directoryCount = u32(opt + (wide ? 108 : 92));
  const directory = index => index < directoryCount && directories + index * 8 + 8 <= opt + optionalSize ? { address: u32(directories + index * 8), size: u32(directories + index * 8 + 4) } : { address: 0, size: 0 };
  const sections = [];
  for (let i = 0; i < count; i++) {
    const o = opt + optionalSize + i * 40; need(o, 40);
    const section = { name: bytes.subarray(o, o + 8).toString('ascii').replace(/\0.*$/, ''), virtualSize: u32(o + 8), rva: u32(o + 12), rawSize: u32(o + 16), rawOffset: u32(o + 20) };
    need(section.rawOffset, section.rawSize); sections.push(section);
  }
  const rvaOffset = (rva, length = 1) => {
    if (rva < u32(opt + 60)) { need(rva, length); if (rva + length > u32(opt + 60)) throw new Error('PE header RVA range crosses headers'); return rva; }
    const s = sections.find(s => rva >= s.rva && rva - s.rva + length <= s.rawSize);
    if (!s) throw new Error('PE RVA is not file backed');
    const offset = s.rawOffset + rva - s.rva; need(offset, length); return offset;
  };
  const cstring = rva => {
    const offset = rvaOffset(rva); let end = offset;
    while (end - offset < 4096 && end < bytes.length && bytes[end] !== 0) { rvaOffset(rva + end - offset); end++; }
    if (end >= bytes.length || bytes[end] !== 0) throw new Error('Unterminated PE import name');
    return bytes.subarray(offset, end).toString('utf8');
  };
  const imports = [], entry = directory(1); let totalSymbols = 0;
  if (entry.address) {
    if (entry.size < 20) throw new Error('Invalid PE import directory size');
    let terminated = false;
    for (let i = 0; i < Math.min(1024, Math.floor(entry.size / 20)); i++) {
      const o = rvaOffset(entry.address + i * 20, 20);
      if (bytes.subarray(o, o + 20).every(byte => byte === 0)) { terminated = true; break; }
      const name = cstring(u32(o + 12)), thunk = u32(o) || u32(o + 16), symbols = [];
      let thunkTerminated = false;
      for (let j = 0; j < 16384; j++) {
        const value = wide ? u64(rvaOffset(thunk + j * 8, 8)) : BigInt(u32(rvaOffset(thunk + j * 4, 4)));
        if (value === 0n) { thunkTerminated = true; break; }
        if (++totalSymbols > 16384) throw new Error('PE import symbol budget exceeded');
        const ordinal = Boolean(value & (wide ? 0x8000000000000000n : 0x80000000n));
        if (!ordinal && value > 0xffffffffn) throw new Error('Invalid PE import name RVA');
        symbols.push(ordinal ? { ordinal: Number(value & 0xffffn) } : { name: cstring(Number(value) + 2) });
      }
      if (!thunkTerminated) throw new Error('Unterminated PE import table');
      imports.push({ library: name, symbols });
    }
    if (!terminated) throw new Error('PE import directory is unterminated or exceeds the budget');
  }
  const certificate = directory(4);
  if (certificate.address || certificate.size) need(certificate.address, certificate.size);
  return { machine: '0x' + u16(nt + 4).toString(16), architecture: ({ 0x14c: 'x86', 0x8664: 'x86_64', 0xaa64: 'arm64' })[u16(nt + 4)] || 'unknown',
    optionalHeader: wide ? 'PE32+' : 'PE32', entryRva: u32(opt + 16), subsystem: u16(opt + 68), sections, imports,
    clrDirectory: directory(14), resourceDirectory: directory(2), delayImportDirectory: directory(13),
    embeddedSignature: { certificateTablePresent: certificate.address !== 0 && certificate.size !== 0, fileOffset: certificate.address, size: certificate.size, trustVerification: 'not_performed', catalogSigning: 'not_inspected' },
    limitations: ['Import presence is not proof of invocation. Delay imports are identified but not decoded.', 'Certificate table presence does not establish signature validity or trust. Resource payloads are not decoded.'] };
}

export function extractStrings(bytes, limit = 2000) {
  const items = []; let matched = 0;
  const keep = (offset, length, encoding) => {
    if (length < (encoding === 'ascii' ? 5 : 10)) return;
    matched++;
    if (items.length < limit) items.push({ offset, encoding, byteLength: length, truncated: length > 1024, text: bytes.subarray(offset, offset + Math.min(length, 1024)).toString(encoding === 'ascii' ? 'latin1' : 'utf16le') });
  };
  let start = -1;
  for (let i = 0; i <= bytes.length; i++) {
    if (i < bytes.length && bytes[i] >= 32 && bytes[i] <= 126) { if (start === -1) start = i; }
    else if (start !== -1) { keep(start, i - start, 'ascii'); start = -1; }
  }
  for (const parity of [0, 1]) {
    start = -1;
    for (let i = parity; i <= bytes.length; i += 2) {
      if (i + 1 < bytes.length && bytes[i] >= 32 && bytes[i] <= 126 && bytes[i + 1] === 0) { if (start === -1) start = i; }
      else if (start !== -1) { keep(start, i - start, 'utf16le'); start = -1; }
    }
  }
  return { items, matched, omitted: matched - items.length, coverage: 'ASCII and printable Latin UTF-16LE byte sequences only; not all encodings or compressed resources' };
}

export async function inspectLocalFile(project, args, jobs, signal) {
  const file = await selectLocalFile(project, args.relativePath);
  const identity = await inspectTarget(file);
  if (file === project.target.targetPath && identity.sha256 !== project.target.sha256) throw new Error('Target changed; create a new project');
  const info = await stat(file);
  if (info.size > MAX_BYTES) throw new Error('Local inspection is limited to 64 MiB per file; select a smaller artifact or use a format-specific provider');
  const bytes = await readFile(file);
  if (createHash('sha256').update(bytes).digest('hex') !== identity.sha256) throw new Error('Target changed during inspection');
  let pe = null, peError = null;
  try { pe = inspectPe(bytes); } catch (error) { peError = error.message; }
  let windows = { status: 'unsupported_host' };
  if (process.platform === 'win32') {
    const result = await jobs.run(project.id, path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-File', path.join(ROOT, 'scripts/inspect-windows.ps1'), '-TargetPath', file], { signal, timeoutMs: 20000, maxBytes: 128 * 1024 });
    try { windows = result.exitCode === 0 && !result.termination ? JSON.parse(result.stdout.replace(/^\uFEFF/, '')) : { status: result.termination || 'failed', diagnostic: result.stderr.slice(-2000) }; }
    catch { windows = { status: 'failed', diagnostic: 'Windows metadata output was not valid JSON' }; }
  }
  if ((await inspectTarget(file)).sha256 !== identity.sha256) throw new Error('Target changed during inspection');
  return { identity, observedAt: new Date().toISOString(), method: 'execution-free-local-file-inspection', pe, peError, windows,
    strings: args.includeStrings === false ? null : extractStrings(bytes, args.maxStrings ?? 2000),
    effects: { executesTarget: false, contactsNetwork: false, changesTarget: false },
    limitations: ['Local inspection is not a complete decompilation, malware assessment, network audit or provenance verification. Strings may contain private data; review before sharing.'] };
}
