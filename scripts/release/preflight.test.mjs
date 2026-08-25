import assert from 'node:assert/strict';
import test from 'node:test';

import { runPreflight } from './preflight.mjs';
import { readRuntimeIdentity } from './read-runtime-identity.mjs';

const TARGET = 'a'.repeat(40);
const BASELINE = 'b'.repeat(40);

function productionIdentity(overrides = {}) {
  const component = (gitSha) => ({ gitSha, deployedAt: '2026-08-25T00:00:00.000Z' });
  return {
    schemaVersion: 1,
    environment: 'production',
    gitSha: BASELINE,
    components: {
      web: component(TARGET),
      api: component(TARGET),
      runtimeWorker: component(TARGET),
      acs: component(TARGET),
    },
    topology: {
      activeColor: 'blue', observedAt: '2026-08-25T00:00:00.000Z',
      api: { unit: 'agent-saas-api@blue.service', releaseSymlink: '/srv/releases/blue', pidfile: '/run/blue-api.pid', readyfile: '/run/blue-api.ready' },
      runtimeWorker: { unit: 'agent-saas-worker@blue.service', releaseSymlink: '/srv/releases/blue', pidfile: '/run/blue-worker.pid', readyfile: '/run/blue-worker.ready' },
    },
    ...overrides,
  };
}

function successfulGit(command, args) {
  assert.equal(command, 'git');
  if (args[0] === 'diff') return 'web/src/App.tsx\nhand-server/src/worker.ts\n';
  return '';
}

test('preflight succeeds for full SHAs, main ancestry, production identity, and mapped changes', () => {
  const result = runPreflight({
    target: TARGET,
    baseline: BASELINE,
    identityPath: 'fixtures/production-runtime-identity.json',
    execFileSync: successfulGit,
    readFileSync: () => JSON.stringify(productionIdentity()),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.components, ['web', 'runtimeWorker']);
  assert.deepEqual(result.blockingReasons, []);
});

test('preflight reports each blocking release condition as JSON data', () => {
  const result = runPreflight({
    target: 'short-sha',
    baseline: TARGET,
    identityPath: 'https://identity.example/production.json',
    execFileSync: successfulGit,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.blockingReasons, [
    'Target must be a complete 40-character SHA.',
    'Runtime identity must be read from a local file path.',
  ]);
});

test('preflight blocks a target outside main, a non-ancestor baseline, incomplete identity, and unknown files', () => {
  const execFileSync = (_command, args) => {
    if (args[0] === 'merge-base') throw new Error('not an ancestor');
    return 'web/src/App.tsx\npackage.json\n';
  };
  const identity = productionIdentity({ components: { web: { gitSha: TARGET } } });

  const result = runPreflight({
    target: TARGET,
    baseline: BASELINE,
    identityPath: 'fixtures/production-runtime-identity.json',
    execFileSync,
    readFileSync: () => JSON.stringify(identity),
  });

  assert.equal(result.ok, false);
  assert.match(result.blockingReasons.join('\n'), /not reachable from main/u);
  assert.match(result.blockingReasons.join('\n'), /not an ancestor/u);
  assert.match(result.blockingReasons.join('\n'), /component "web" must have an ISO/u);
  assert.match(result.blockingReasons.join('\n'), /missing component "api"/u);
  assert.match(result.blockingReasons.join('\n'), /not mapped to a release component: package.json/u);
});

test('preflight fails closed for conflicting production topology or component baseline', () => {
  const topologyConflict = productionIdentity({ topology: { ...productionIdentity().topology, api: { ...productionIdentity().topology.api, pidfile: '/run/green-api.pid' } } });
  const conflict = runPreflight({ target: TARGET, baseline: BASELINE, identityPath: './production.json', execFileSync: successfulGit, readFileSync: () => JSON.stringify(topologyConflict) });
  assert.equal(conflict.ok, false);
  assert.match(conflict.blockingReasons.join('\n'), /pidfile conflicts with activeColor/u);
  const baselineConflict = productionIdentity({ gitSha: TARGET });
  const stale = runPreflight({ target: TARGET, baseline: BASELINE, identityPath: './production.json', execFileSync: successfulGit, readFileSync: () => JSON.stringify(baselineConflict) });
  assert.equal(stale.ok, false);
  assert.match(stale.blockingReasons.join('\n'), /does not match the supplied baseline/u);
});

test('runtime identity rejects placeholder topology fields', () => {
  const identity = productionIdentity({ topology: { ...productionIdentity().topology, api: { unit: 'blue', releaseSymlink: 'blue', pidfile: 'blue', readyfile: 'blue' } } });
  const result = readRuntimeIdentity({ identityPath: './production.json', readFileSync: () => JSON.stringify(identity) });
  assert.equal(result.ok, false);
  assert.match(result.blockingReasons.join('\n'), /colored systemd unit/u);
  assert.match(result.blockingReasons.join('\n'), /absolute path/u);
});

test('runtime identity accepts only local, complete production JSON', () => {
  const valid = readRuntimeIdentity({
    identityPath: './production.json',
    readFileSync: () => JSON.stringify(productionIdentity()),
  });
  assert.equal(valid.ok, true);

  const invalidJson = readRuntimeIdentity({
    identityPath: './production.json',
    readFileSync: () => '{',
  });
  assert.equal(invalidJson.ok, false);
  assert.match(invalidJson.blockingReasons[0], /Unable to read production runtime identity JSON/u);
});
