import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { collectDiagnostics } from './collect-promotion-diagnostics.mjs';

// Real uploader, timeout supervisors, gzip/cmp, terminal receipts and collector.
// Only remote I/O is replaced; these assertions are not an OSS/CDN acceptance run.
const fakeIo = `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const root = process.env.DIAGNOSTIC_TEST_ROOT;
const curl = path.basename(process.argv[1]) === 'curl';
const [helper, ...args] = process.argv.slice(2);
const phase = curl ? 'public-head' : helper.includes('/put-') ? 'put' : helper.includes('/get-') ? 'readback' : 'metadata';
const key = curl ? new URL(process.argv.at(-1)).pathname.slice(1) : phase === 'readback' ? args[1] : args[2];
const target = path.join(root, 'store', key);
fs.appendFileSync(path.join(root, 'pids.jsonl'), JSON.stringify(process.pid) + '\\n');
process.on('SIGTERM', () => process.exit(143));
if (curl && process.env.DIAGNOSTIC_TEST_HANG === key) {
  setTimeout(() => { fs.writeFileSync(path.join(root, 'late-write'), 'unsafe'); }, 30000);
} else if (phase === 'put') {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    console.error('OSS_CREATE_ONLY_CONFLICT FileAlreadyExists status=409'); process.exitCode = 17;
  } else fs.copyFileSync(args[0], target);
} else if (phase === 'readback') {
  fs.copyFileSync(target, args[3]);
} else if (curl) {
  const css = key.endsWith('.css'); const js = key.endsWith('.js');
  console.log('HTTP/1.1 200 OK\\r\\ncache-control: public, max-age=31536000, immutable\\r');
  console.log('content-type: ' + (css ? 'text/css; charset=utf-8' : js ? 'text/javascript; charset=utf-8' : 'image/svg+xml') + '\\r');
  if (css || js) console.log('content-encoding: gzip\\r');
}
`;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'asset diagnostics integration '));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ['assets', 'bin', 'store']) await mkdir(join(root, name));
  await writeFile(join(root, 'assets/app.js'), 'console.log("asset");\n');
  await writeFile(join(root, 'assets/style.css'), 'body {}\n');
  for (let index = 0; index < 10; index++)
    await writeFile(join(root, `assets/image-${index}.svg`), '<svg/>\n');
  await writeFile(join(root, 'credentials.json'), '{"accessKeySecret":"DO_NOT_EXPORT"}');
  for (const name of ['node', 'curl'])
    await writeFile(join(root, 'bin', name), fakeIo, { mode: 0o755 });
  return root;
}
function upload(root, output, hang = '') {
  return spawnSync('bash', [
    resolve('scripts/release/upload-web-assets-immutable.sh'), join(root, 'assets'),
    'oss://test-bucket/assets', join(root, 'credentials.json'), '', 'https://example.test',
    '1', hang ? '1' : '5', join(output, 'web-asset-diagnostics'),
  ], {
    encoding: 'utf8', timeout: 25000,
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      OSS_REGION: 'cn-shenzhen', DIAGNOSTIC_TEST_ROOT: root, DIAGNOSTIC_TEST_HANG: hang },
  });
}
async function summary(root) {
  const out = join(root, 'summary');
  const report = await collectDiagnostics(root, out);
  const serialized = await readFile(join(out, 'summary.json'), 'utf8');
  assert.doesNotMatch(serialized, /DO_NOT_EXPORT/u);
  assert.deepEqual(JSON.parse(serialized), report);
  return report.webAssets;
}
async function assertReaped(root) {
  const pids = (await readFile(join(root, 'pids.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  for (const pid of new Set(pids))
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await assert.rejects(readFile(join(root, 'late-write')), { code: 'ENOENT' });
}

test('H04/H08 real uploader produces complete diagnostics beyond eight resources, including reuse', { timeout: 30000 }, async (t) => {
  const root = await fixture(t);
  for (const [name, uploaded, reused] of [['first', 12, 0], ['second', 0, 12]]) {
    const output = join(root, name);
    const result = upload(root, output);
    assert.equal(result.status, 0, result.stderr);
    const report = await summary(output);
    assert.equal(report.batch.status, 'completed');
    assert.equal(report.batch.uploaded, uploaded);
    assert.equal(report.batch.reused, reused);
    assert.equal(report.coverage.status, 'complete');
    assert.equal(report.coverage.filesRead, 12);
    assert.equal(report.coverage.assetsObserved, 12);
    assert.equal(report.coverage.terminalSuccesses, 12);
    assert.equal(report.coverage.eventsOmitted, 0);
    assert.equal(report.truncated, false);
    assert.equal(report.resourceTimings.samples, 12);
    assert.equal(report.phaseTimings['public-head'].samples, 12);
  }
  await assertReaped(root);
});

test('original T09 subset: a late HEAD timeout survives one portable failure summary without a false percentile population', { timeout: 30000 }, async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'assets/zz-last.js'), 'console.log("last");\n');
  const output = join(root, 'failed');
  const result = upload(root, output, 'assets/zz-last.js');
  assert.equal(result.status, 124, result.stderr);
  const report = await summary(output);
  assert.equal(report.batch.status, 'failed');
  assert.equal(report.batch.exitCode, 124);
  assert.equal(report.batch.total, 13);
  assert.equal(report.batch.completed, 12);
  assert.equal(report.coverage.filesRead, 13);
  assert.equal(report.coverage.status, 'partial');
  assert.equal(report.coverage.terminalFailures, 1);
  assert.equal(report.coverage.nonzeroEventsOmitted, 0);
  assert.deepEqual(report.events.filter((event) => event.key === 'zz-last.js' &&
    event.phase === 'public-head' && event.attempt > 0).map((event) => event.attempt), [1, 2]);
  assert.ok(report.events.some((event) => event.key === 'zz-last.js' &&
    event.phase === 'verify' && event.exitCode === 124));
  assert.equal(report.phaseTimings, null);
  assert.equal(report.resourceTimings, null);
  await assertReaped(root);
});
