import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { JobManager } from '../lib/jobs.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { workspace } from './helpers.mjs';

test('timeout stops a live owned process and releases its job', async () => {
  const jobs = new JobManager();
  const result = await jobs.run('test', process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 350 });
  assert.equal(result.termination, 'timeout');
  assert.deepEqual(jobs.list(), []);
});

test('closing one project stops its job while another owned job can finish', async () => {
  const jobs = new JobManager();
  const first = jobs.run('one', process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  const second = jobs.run('two', process.execPath, ['-e', 'setTimeout(() => console.log("finished"), 500)']);
  await delay(60);
  const stopped = await jobs.stop('one');
  assert.equal(stopped.remaining.length, 0);
  assert.equal((await first).termination, 'cancelled');
  assert.match((await second).stdout, /finished/);
  await jobs.shutdown();
});

test('large output is bounded and terminates the offending job', async () => {
  const jobs = new JobManager();
  const result = await jobs.run('test', process.execPath, ['-e', 'setInterval(() => console.log("x".repeat(1000)), 1)'], { maxBytes: 1500 });
  assert.equal(result.termination, 'output_limit');
  assert.ok(result.stdout.length <= 1500);
  assert.deepEqual(jobs.list(), []);
});

test('owned descendant processes are stopped with their parent', async t => {
  const { root, service } = await workspace(t);
  const pidFile = path.join(root, 'owned-child.pid');
  const code = `const {spawn}=require('node:child_process'); const {writeFileSync}=require('node:fs');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
    writeFileSync(${JSON.stringify(pidFile)},String(child.pid)); setInterval(()=>{},1000);`;
  const run = service.jobs.run('tree', process.execPath, ['-e', code]);
  let descendant = null;
  for (let attempt = 0; attempt < 60 && !descendant; attempt++) {
    await delay(20);
    descendant = await readFile(pidFile, 'utf8').then(Number).catch(() => null);
  }
  assert.ok(descendant, 'Owned test child did not start');
  await service.jobs.stop('tree');
  assert.equal((await run).termination, 'cancelled');
  assert.throws(() => process.kill(descendant, 0), /ESRCH/);
});
