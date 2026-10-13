import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { checkEnvironment, prepareEnvironment, fullJdkModules, supportedNode } from '../lib/environment.mjs';
import { reaEnvironment, ROOT } from '../lib/config.mjs';
import { workspace } from './helpers.mjs';
import { writeFixtureZip } from './fixtures/android.mjs';

test('missing dependencies produce an actionable plan without starting target or installing', async t => {
  const { service } = await workspace(t);
  const checked = await checkEnvironment(service.config, 'android', service.jobs, undefined, false);
  assert.equal(checked.ready, false);
  assert.deepEqual(checked.installable, ['rea', 'jdk', 'jadx']);
  const prepared = await prepareEnvironment(service.config, { components: checked.installable }, service.jobs);
  assert.deepEqual(prepared.installed, []);
  assert.equal(service.config.rea, null);
  assert.equal(service.jobs.list().length, 0);
});

test('analysis engine configuration is scoped to child processes', () => {
  const original = { JAVA_HOME: 'company-java', PATH: 'existing-path' };
  const scoped = reaEnvironment({ javaHome: 'analysis-java', jadxJar: 'engine.jar' }, original);
  assert.equal(scoped.JAVA_HOME, 'analysis-java');
  assert.equal(scoped.REA_JADX_MCP_JAR, 'engine.jar');
  assert.equal(original.JAVA_HOME, 'company-java');
  assert.ok(!('REA_JADX_MCP_JAR' in original));
});

test('version checks do not treat an old Node, mismatched REA or a modular JRE as ready', async () => {
  assert.equal(supportedNode('v22.18.0'), false);
  assert.equal(supportedNode('v24.10.0'), false);
  assert.equal(supportedNode('v24.14.1'), true);
  assert.equal(supportedNode('v26.0.0'), true);
  assert.equal(fullJdkModules('java.base@21\njava.desktop@21'), false);
  assert.equal(fullJdkModules('java.base@11\njdk.compiler@11'), false);
  assert.equal(fullJdkModules('java.base@21\njdk.compiler@21'), true);
  const result = await checkEnvironment({ rea: { version: '6.3.0' } }, 'basic', null, undefined, false);
  assert.equal(result.ready, false);
  assert.deepEqual(result.installable, ['rea']);
});

test('portable dependency extraction accepts a regular ZIP and refuses traversal before writing', { skip: process.platform !== 'win32' }, async t => {
  const { root, service } = await workspace(t);
  const managed = path.join(root, 'managed'); await mkdir(managed);
  const archive = path.join(managed, 'safe.zip'), destination = path.join(managed, 'extracted');
  await writeFixtureZip(archive, [['jdk-example/bin/readme.txt', Buffer.from('learning fixture')]]);
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const run = (file, directory) => service.jobs.run('environment', powershell, ['-NoProfile', '-File', path.join(ROOT, 'scripts/extract-zip.ps1'), '-Archive', file, '-Destination', directory, '-ManagedRoot', managed]);
  assert.equal((await run(archive, destination)).exitCode, 0);
  assert.equal(await readFile(path.join(destination, 'jdk-example/bin/readme.txt'), 'utf8'), 'learning fixture');
  const malicious = path.join(managed, 'traversal.zip');
  await writeFixtureZip(malicious, [['../../escaped.txt', Buffer.from('must not be extracted')]]);
  assert.notEqual((await run(malicious, path.join(managed, 'rejected'))).exitCode, 0);
  await assert.rejects(access(path.join(root, 'escaped.txt')));
});
