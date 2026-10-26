import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { downloadVerified } from '../lib/downloads.mjs';
import { workspace } from './helpers.mjs';

const bytes = Buffer.from('a harmless dependency fixture');
const expected = createHash('sha256').update(bytes).digest('hex');
const url = 'https://example.invalid/fixture.zip';
const response = (body, status = 200, extra = {}) => ({ status, headers: new Headers({ etag: '"fixture-v1"', ...extra }), body: (async function* () { yield body; })() });
const interrupted = () => ({ status: 200, headers: new Headers({ etag: '"fixture-v1"', 'content-length': String(bytes.length) }),
  body: (async function* () { yield bytes.subarray(0, 5); throw new Error('fixture interruption'); })() });

test('an interrupted body resumes with validated Range and never admits an incomplete final file', async t => {
  const { root } = await workspace(t), file = path.join(root, 'dependency.zip');
  await assert.rejects(downloadVerified(url, file, expected, undefined, { fetchImpl: async () => interrupted() }), /fixture interruption/);
  await assert.rejects(access(file));
  assert.equal((await readFile(file + '.part')).length, 5);
  let requested;
  const result = await downloadVerified(url, file, expected, undefined, { fetchImpl: async (_, options) => {
    requested = options.headers;
    return response(bytes.subarray(5), 206, { 'content-range': `bytes 5-${bytes.length - 1}/${bytes.length}` });
  } });
  assert.equal(requested.Range, 'bytes=5-'); assert.equal(requested['If-Range'], '"fixture-v1"');
  assert.equal(result.resumedBytes, 5); assert.deepEqual(await readFile(file), bytes);
  await assert.rejects(access(file + '.part'));
  assert.equal((await downloadVerified(url, file, expected, undefined, { fetchImpl: () => { throw new Error('must reuse'); } })).state, 'reused');
});

test('a server ignoring Range restarts safely instead of appending a complete body', async t => {
  const { root } = await workspace(t), file = path.join(root, 'dependency.zip');
  await assert.rejects(downloadVerified(url, file, expected, undefined, { fetchImpl: async () => interrupted() }));
  const result = await downloadVerified(url, file, expected, undefined, { fetchImpl: async () => response(bytes) });
  assert.equal(result.resumedBytes, 0); assert.deepEqual(await readFile(file), bytes);
});

test('wrong ranges, wrong digest and oversized bodies never become installed dependencies', async t => {
  const { root } = await workspace(t), file = path.join(root, 'dependency.zip');
  await assert.rejects(downloadVerified(url, file, expected, undefined, { fetchImpl: async () => interrupted() }));
  await assert.rejects(downloadVerified(url, file, expected, undefined, { fetchImpl: async () => response(bytes, 206, { 'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}` }) }), /Content-Range/);
  await assert.rejects(access(file));
  await assert.rejects(downloadVerified(url, file, expected, undefined, { fetchImpl: async () => response(bytes.subarray(5), 206, { etag: '"fixture-v2"', 'content-range': `bytes 5-${bytes.length - 1}/${bytes.length}` }) }), /validator changed/);
  await assert.rejects(downloadVerified(url, file, expected, undefined, { fetchImpl: async () => response(Buffer.from('wrong')) }), /SHA-256/);
  await assert.rejects(access(file));
  const tooBig = path.join(root, 'large.zip');
  await assert.rejects(downloadVerified(url, tooBig, expected, undefined, { maxBytes: 2, fetchImpl: async () => response(bytes) }), /size budget/);
  await assert.rejects(access(tooBig));
});

test('HTTPS redirects cannot downgrade transport', async t => {
  const { root } = await workspace(t); let calls = 0;
  await assert.rejects(downloadVerified(url, path.join(root, 'dependency.zip'), expected, undefined, { fetchImpl: async () => {
    calls++; return new Response(null, { status: 302, headers: { location: 'http://example.invalid/fixture.zip' } });
  } }), /remain HTTPS/);
  assert.equal(calls, 1);
});

test('an existing preparation lock is reported without touching it or fetching data', async t => {
  const { root } = await workspace(t), file = path.join(root, 'dependency.zip');
  const lock = file + '.part.lock'; await writeFile(lock, 'external preparation marker');
  await assert.rejects(downloadVerified(url, file, expected, undefined, { fetchImpl: () => { assert.fail('must not fetch'); } }), /locked/);
  assert.equal(await readFile(lock, 'utf8'), 'external preparation marker');
});

test('cancellation retains partial progress and releases the preparation lock', async t => {
  const { root } = await workspace(t), file = path.join(root, 'dependency.zip');
  const controller = new AbortController();
  await assert.rejects(downloadVerified(url, file, expected, controller.signal, { fetchImpl: async () => ({ status: 200,
    headers: new Headers({ etag: '"fixture-v1"' }), body: (async function* () {
      yield bytes.subarray(0, 5); controller.abort(new Error('fixture cancellation')); yield bytes.subarray(5);
    })(),
  }) }), /fixture cancellation/);
  assert.equal((await readFile(file + '.part')).length, 5);
  await assert.rejects(access(file + '.part.lock'));
  await assert.rejects(access(file));
});
