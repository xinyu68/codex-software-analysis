import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function info(file) {
  const value = await lstat(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (value && (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1)) throw new Error('Download path must be a regular, unlinked managed file');
  return value;
}
async function sha(file) { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex'); }
const remove = file => unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });

export async function downloadVerified(url, destination, expected, signal, { fetchImpl = fetch, timeoutMs = 600000, maxBytes = 384 * 1024 * 1024 } = {}) {
  if (new URL(url).protocol !== 'https:' || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('A HTTPS source and exact SHA-256 are required');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new Error('Invalid dependency download budget');
  if (!path.isAbsolute(destination)) throw new Error('Managed download destination must be absolute');
  await mkdir(path.dirname(destination), { recursive: true });
  if (await info(destination)) {
    if (await sha(destination) !== expected) throw new Error('Existing managed dependency changed');
    return { state: 'reused', destination, sha256: expected };
  }
  const partial = destination + '.part', metadata = partial + '.json', lockPath = partial + '.lock';
  await info(partial); await info(metadata);
  const lock = await open(lockPath, 'wx', 0o600).catch(error => { if (error.code === 'EEXIST') throw new Error('Download is locked by another or interrupted preparation; inspect the managed .lock file before retrying'); throw error; });
  const source = createHash('sha256').update(url).digest('hex');
  const control = AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(timeoutMs)]);
  let bytes = 0, resumedBytes = 0;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), source, expected }));
    let previous = await readFile(metadata, 'utf8').then(JSON.parse).catch(() => null);
    const partInfo = await info(partial);
    const compatible = previous?.source === source && previous?.expected === expected && previous?.validator && partInfo?.size > 0 && partInfo.size <= maxBytes;
    bytes = compatible ? partInfo.size : 0;
    if (partInfo && partInfo.size > maxBytes) throw new Error('Partial dependency exceeds the size budget');
    if (partInfo && await sha(partial) === expected) bytes = partInfo.size;
    else {
      const request = async headers => {
        let current = url;
        for (let redirect = 0; redirect <= 5; redirect++) {
          const response = await fetchImpl(current, { headers, signal: control, redirect: 'manual' });
          if (![301, 302, 303, 307, 308].includes(response.status)) return response;
          const location = response.headers.get('location');
          if (!location) throw new Error('Dependency redirect has no location');
          const next = new URL(location, current);
          if (next.protocol !== 'https:') throw new Error('Dependency redirect must remain HTTPS');
          await response.body?.cancel(); current = next.href;
        }
        throw new Error('Too many dependency redirects');
      };
      let response = await request(bytes ? { Range: `bytes=${bytes}-`, 'If-Range': previous.validator } : {});
      if (response.status === 416 && bytes) { await response.body?.cancel(); bytes = 0; response = await request({}); }
      if (![200, 206].includes(response.status)) throw new Error(`Dependency download failed (${response.status})`);
      let total = null, rangeEnd = null;
      if (response.status === 206) {
        const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
        if (!range || Number(range[1]) !== bytes || Number(range[2]) < bytes || Number(range[3]) <= Number(range[2])) throw new Error('Invalid dependency Content-Range');
        total = Number(range[3]); rangeEnd = Number(range[2]); resumedBytes = bytes;
      } else {
        // A server can ignore Range or return a changed entity. Restart, never append a full response.
        bytes = 0;
        const length = response.headers.get('content-length'); total = length === null ? null : Number(length);
      }
      if (total !== null && (!Number.isSafeInteger(total) || total < 0 || total > maxBytes)) throw new Error('Dependency exceeds the size budget');
      const etag = response.headers.get('etag'), modified = response.headers.get('last-modified');
      const validator = etag && !etag.startsWith('W/') ? etag : modified || null;
      if (resumedBytes && validator !== previous.validator) throw new Error('Dependency entity validator changed during resume');
      await writeFile(metadata, JSON.stringify({ source, expected, validator, total, updatedAt: new Date().toISOString() }), { mode: 0o600 });
      await info(partial);
      const file = await open(partial, bytes ? 'a' : 'w', 0o600);
      try {
        if (!response.body) throw new Error('Dependency response has no body');
        for await (const chunk of response.body) {
          control.throwIfAborted();
          if (bytes + chunk.length > maxBytes) throw new Error('Dependency exceeds the size budget');
          let offset = 0;
          while (offset < chunk.length) { const written = await file.write(chunk, offset, chunk.length - offset); if (!written.bytesWritten) throw new Error('Short dependency write'); offset += written.bytesWritten; }
          bytes += chunk.length;
        }
      } finally { await file.close(); }
      if (rangeEnd !== null && bytes !== rangeEnd + 1 || total !== null && bytes !== total) throw new Error('Incomplete dependency body; validated checkpoint retained for retry');
    }
    if (await sha(partial) !== expected) {
      // An invalid completed body must not be admitted or reused as a valid resume checkpoint.
      await remove(metadata);
      throw new Error('Downloaded dependency SHA-256 does not match the selected release; final destination was not created');
    }
    control.throwIfAborted();
    await copyFile(partial, destination, 1);
    await remove(partial); await remove(metadata);
    return { state: 'prepared', destination, sha256: expected, bytes, resumedBytes };
  } catch (error) {
    throw new Error(`${error.message}; partial progress, if any, is retained in the managed .part file`, { cause: error });
  } finally { await lock.close(); await remove(lockPath); }
}
