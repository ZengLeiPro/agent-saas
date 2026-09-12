import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const uploader = resolve('scripts/release/upload-web-assets-immutable.sh');
// Exercise the real shell pool, timeout supervisors and signal handling. Only remote
// I/O is replaced; upload-web-assets-immutable.test.mjs covers the real SDK helpers.
const fakeIo = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const env = process.env;
const curl = path.basename(process.argv[1]) === 'curl';
const [helper, ...args] = process.argv.slice(2);
const phase = curl ? 'public-head' : helper.includes('/put-') ? 'put' : helper.includes('/get-') ? 'readback' : 'metadata';
const key = curl ? new URL(process.argv.at(-1)).pathname.slice(1) : phase === 'readback' ? args[1] : args[2];
const target = path.join(env.FAKE_POOL_STORE, key);
const event = (kind) => fs.appendFileSync(env.FAKE_POOL_LOG, JSON.stringify({ kind, phase, key, pid: process.pid }) + '\\n');
event('start');
process.on('exit', () => event('end'));
process.on('SIGTERM', () => process.exit(143));
async function main() {
  if (phase === 'put' && env.FAKE_POOL_DENIED === 'true') {
    console.error('AccessDenied'); process.exitCode = 1; return;
  }
  if (env.FAKE_POOL_HANG === phase && key === 'assets/app.js') {
    const marker = path.join(env.FAKE_POOL_STORE, 'timed-out-once');
    if (env.FAKE_POOL_ONCE !== 'true' || !fs.existsSync(marker)) {
      fs.writeFileSync(marker, 'started');
      if (phase === 'put') {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(args[0], target);
      }
      await new Promise((done) => setTimeout(done, 30000));
      event('late-write');
    }
  }
  await new Promise((done) => setTimeout(done, 120));
  if (phase === 'put') {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) {
      console.error('OSS_CREATE_ONLY_CONFLICT FileAlreadyExists status=409');
      process.exitCode = 17; return;
    }
    fs.copyFileSync(args[0], target);
  } else if (phase === 'readback') {
    fs.copyFileSync(target, args[3]);
  } else if (curl) {
    for (const flag of ['--connect-timeout', '--max-time', '--retry', '--retry-max-time']) {
      if (!process.argv.includes(flag)) throw new Error('Missing bounded curl flag: ' + flag);
    }
    const type = key.endsWith('.js') ? 'text/javascript; charset=utf-8' : key.endsWith('.css') ? 'text/css; charset=utf-8' : 'image/svg+xml';
    console.log('HTTP/1.1 200 OK\\r\\ncache-control: public, max-age=31536000, immutable\\r\\ncontent-type: ' + type + '\\r');
    if (/\\.(js|css)$/.test(key)) console.log('content-encoding: gzip\\r');
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
`;

async function fixture(t, extraAssets = 0) {
  const root = await mkdtemp(join(tmpdir(), 'web pool spaces-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['assets', 'bin', 'store', 'temp']) await mkdir(join(root, dir));
  await writeFile(
    join(root, 'credentials.json'),
    '{"accessKeyId":"redacted","accessKeySecret":"do-not-log-me"}',
  );
  await writeFile(join(root, 'assets', 'app.js'), 'console.log("stable");\n');
  await writeFile(join(root, 'assets', 'style.css'), 'body {}\n');
  for (let i = 0; i < extraAssets; i++) {
    await writeFile(join(root, 'assets', `image-${i}.svg`), '<svg/>\n');
  }
  for (const name of ['node', 'curl']) {
    await writeFile(join(root, 'bin', name), fakeIo);
    await chmod(join(root, 'bin', name), 0o755);
  }
  return root;
}

function start(root, { jobs, seconds, env = {}, detached = false } = {}) {
  const args = [
    uploader,
    join(root, 'assets'),
    'oss://web-bucket/assets',
    join(root, 'credentials.json'),
    '',
    'https://web.example.com',
  ];
  if (jobs !== undefined) args.push(String(jobs));
  if (seconds !== undefined) args.push(String(seconds));
  const child = spawn('bash', args, {
    detached,
    env: {
      ...process.env,
      PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      TMPDIR: join(root, 'temp'),
      OSS_REGION: 'cn-shenzhen',
      FAKE_POOL_LOG: join(root, 'events.jsonl'),
      FAKE_POOL_STORE: join(root, 'store'),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const result = new Promise((resolveResult, reject) => {
    child.on('error', reject);
    child.on('close', (status, signal) => resolveResult({ status, signal, stdout, stderr }));
  });
  return { child, result };
}

async function events(root) {
  try {
    return (await readFile(join(root, 'events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function assertReaped(root) {
  const log = await events(root);
  for (const pid of new Set(log.map((entry) => entry.pid))) {
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
  assert.ok(log.every((entry) => entry.kind !== 'late-write'));
}

test('default pool overlaps requests, never exceeds four workers, and counts verified receipts', { timeout: 20000 }, async (t) => {
  const root = await fixture(t, 6);
  const first = await start(root).result;
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /concurrency=4/u);
  assert.match(first.stdout, /uploaded=8 reused=0 js=1 css=1/u);
  assert.match(first.stdout, /phase=public-head/u);
  assert.doesNotMatch(first.stdout + first.stderr, /do-not-log-me/u);
  let active = 0;
  let maximum = 0;
  for (const entry of await events(root)) {
    active += entry.kind === 'start' ? 1 : -1;
    maximum = Math.max(maximum, active);
  }
  assert.ok(maximum > 1, 'requests should overlap');
  assert.ok(maximum <= 4, `observed ${maximum} simultaneous requests`);
  assert.equal(active, 0);
  const second = await start(root, { jobs: 2 }).result;
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /uploaded=0 reused=8/u);
  await assertReaped(root);
});

test('lost PUT acknowledgement retries create-only and verifies the resulting 409', { timeout: 10000 }, async (t) => {
  const root = await fixture(t);
  const result = await start(root, { jobs: 2, seconds: 1, env: { FAKE_POOL_HANG: 'put', FAKE_POOL_ONCE: 'true' } }).result;
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /retrying once: key=app.js phase=put/u);
  assert.match(result.stdout, /uploaded=1 reused=1/u);
  const attempts = (await events(root)).filter((entry) => entry.kind === 'start' && entry.phase === 'put' && entry.key === 'assets/app.js');
  assert.equal(attempts.length, 2);
  await assertReaped(root);
});

for (const phase of ['put', 'readback', 'metadata', 'public-head']) {
  test(`bounded ${phase} failure reports the asset and reaps all workers`, { timeout: 15000 }, async (t) => {
    const root = await fixture(t, 2);
    if (phase === 'metadata') assert.equal((await start(root).result).status, 0);
    const result = await start(root, { jobs: 2, seconds: 1, env: { FAKE_POOL_HANG: phase } }).result;
    assert.equal(result.status, 124, result.stderr);
    assert.match(result.stderr, new RegExp(`key=app.js phase=${phase} exit=124`, 'u'));
    assert.doesNotMatch(result.stdout, /immutable Web assets verified:/u);
    await assertReaped(root);
  });
}

test('permanent failures stop scheduling and do not retry or publish a success summary', { timeout: 10000 }, async (t) => {
  const root = await fixture(t, 6);
  const result = await start(root, { jobs: 1, env: { FAKE_POOL_DENIED: 'true' } }).result;
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AccessDenied/u);
  assert.doesNotMatch(result.stderr, /retrying/u);
  assert.doesNotMatch(result.stdout, /immutable Web assets verified:/u);
  const starts = (await events(root)).filter((entry) => entry.kind === 'start');
  assert.equal(starts.length, 1);
  await assertReaped(root);
});

test('invalid resource sets and limits fail before any remote write', { timeout: 10000 }, async (t) => {
  const root = await fixture(t);
  for (const options of [{ jobs: 0 }, { jobs: 9 }, { jobs: 1, seconds: 0 }, { jobs: 1, seconds: 121 }]) {
    assert.notEqual((await start(root, options).result).status, 0);
  }
  await rm(join(root, 'assets', 'style.css'));
  const result = await start(root).result;
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must contain JavaScript and CSS/u);
  assert.equal((await events(root)).length, 0);
});

for (const wholeGroup of [false, true]) {
  test(`cancellation reaps requests before returning (${wholeGroup ? 'workflow process group' : 'uploader only'})`, { timeout: 15000 }, async (t) => {
    const root = await fixture(t, 4);
    const { child, result } = start(root, { jobs: 2, detached: true, env: { FAKE_POOL_HANG: 'put' } });
    t.after(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    });
    let started = false;
    for (let i = 0; i < 100; i++) {
      if ((await events(root)).some((entry) => entry.phase === 'put' && entry.key === 'assets/app.js')) {
        started = true;
        break;
      }
      await delay(30);
    }
    assert.ok(started, 'fixture request should start');
    process.kill(wholeGroup ? -child.pid : child.pid, 'SIGTERM');
    const stopped = await result;
    assert.notEqual(stopped.status, 0);
    assert.doesNotMatch(stopped.stdout, /immutable Web assets verified:/u);
    await assertReaped(root);
  });
}
