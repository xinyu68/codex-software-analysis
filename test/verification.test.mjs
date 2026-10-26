import test from 'node:test';
import assert from 'node:assert/strict';
import { validateVerification } from '../lib/verification.mjs';

const snapshot = { method: 'process_snapshot', observedBy: 'tool', subject: 'fixture process', coverage: 'Two samples only',
  networkScope: 'connection_snapshot', startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:00:01Z' };

test('live claims require scope and cannot turn user reports or snapshots into broader proof', () => {
  assert.throws(() => validateVerification(null, 'live_verified'), /explicit verification scope/);
  assert.deepEqual(validateVerification(snapshot, 'live_verified'), snapshot);
  assert.throws(() => validateVerification({ ...snapshot, networkScope: 'isolation_test' }, 'live_verified'), /snapshot/);
  assert.throws(() => validateVerification({ ...snapshot, method: 'user_report', observedBy: 'user' }, 'live_verified'), /User reports/);
  assert.throws(() => validateVerification({ ...snapshot, endedAt: '2025-01-01T00:00:00Z' }, 'live_verified'), /time window/);
  assert.throws(() => validateVerification({ ...snapshot, startedAt: '2026-01-01' }, 'live_verified'), /timezone/);
  assert.throws(() => validateVerification({ ...snapshot, method: 'functional_test' }, 'live_verified'), /expectedOutput/);
  const functional = { ...snapshot, method: 'functional_test', networkScope: 'not_assessed', input: 'call a local fixture', expectedOutput: '42', actualOutput: '42' };
  assert.deepEqual(validateVerification(functional, 'live_verified'), functional);
});
