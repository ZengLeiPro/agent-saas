import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

const SCRIPT = resolve('scripts/release/production-lock-lease.sh');

function run(mode, token, environment) {
  return spawnSync('bash', [SCRIPT, mode, token], {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
}

async function waitForAssertion(token, environment) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = run('assert', token, environment);
    if (result.status === 0) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.fail('production lock lease did not become ready');
}

test('production lock lease excludes competitors and releases with PID/start-time ownership proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'production-lock-lease-'));
  const environment = {
    PRODUCTION_LOCK_FILE: join(root, 'promotion.lock'),
    PRODUCTION_LOCK_STATE_ROOT: join(root, 'state'),
    PRODUCTION_LOCK_TIMEOUT_SECONDS: '10',
  };
  const token = '123-1-compat-web';
  const holder = spawn('bash', [SCRIPT, 'hold', token], {
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForAssertion(token, environment);

  const competitor = run('hold', '124-1-competitor', environment);
  assert.equal(competitor.status, 1);
  assert.match(competitor.stderr, /Another production promotion is active/u);

  const released = run('release', token, environment);
  assert.equal(released.status, 0, released.stderr);
  const holderStatus = await new Promise((resolveExit) => holder.once('exit', resolveExit));
  assert.equal(holderStatus, 0);

  const staleAssertion = run('assert', token, environment);
  assert.notEqual(staleAssertion.status, 0);
});

test('production lock lease rejects a stale owner after abrupt termination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'production-lock-stale-owner-'));
  const environment = {
    PRODUCTION_LOCK_FILE: join(root, 'promotion.lock'),
    PRODUCTION_LOCK_STATE_ROOT: join(root, 'state'),
    PRODUCTION_LOCK_TIMEOUT_SECONDS: '10',
  };
  const token = '125-1-stale-owner';
  const holder = spawn('bash', [SCRIPT, 'hold', token], {
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForAssertion(token, environment);
  holder.kill('SIGKILL');
  await new Promise((resolveExit) => holder.once('exit', resolveExit));

  const staleAssertion = run('assert', token, environment);
  assert.notEqual(staleAssertion.status, 0);
});

test('production lock lease rejects unsafe tokens', () => {
  const result = run('assert', '../escape', {});
  assert.equal(result.status, 2);
  assert.match(result.stderr, /token is invalid/u);
});
