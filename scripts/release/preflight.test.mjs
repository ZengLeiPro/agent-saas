import assert from 'node:assert/strict';
import test from 'node:test';

import { TRUSTED_PRODUCTION_IDENTITY_PATH, runPreflight } from './preflight.mjs';
import { readRuntimeIdentity } from './read-runtime-identity.mjs';

const TARGET = 'a'.repeat(40);
const BASELINE = 'b'.repeat(40);
const DIGEST = `sha256:${'c'.repeat(64)}`;
const RELEASE_TARGET = `/opt/agent-saas-app/releases/${'c'.repeat(64)}`;

function productionIdentity(overrides = {}) {
  const component = (gitSha) => ({
    gitSha,
    artifactDigest: DIGEST,
    deployedAt: '2026-08-25T00:00:00.000Z',
  });
  return {
    schemaVersion: 1,
    environment: 'production',
    gitSha: BASELINE,
    configSchemaVersion: 1,
    configFingerprint: DIGEST,
    components: {
      web: component(TARGET),
      api: component(TARGET),
      runtimeWorker: component(TARGET),
      acs: {
        gitSha: TARGET,
        orchestratorArtifactDigest: DIGEST,
        sandboxImageDigest: DIGEST,
        deployedAt: '2026-08-25T00:00:00.000Z',
      },
    },
    topology: {
      observedAt: '2026-08-25T00:00:00.000Z',
      api: {
        activeColor: 'blue',
        activeColorFile: '/etc/agent-saas/active-color',
        unit: 'agent-saas-server@blue.service',
        releaseSymlink: '/opt/agent-saas-app/color/blue',
        releaseTarget: RELEASE_TARGET,
        pidfile: '/run/agent-saas-server-blue.pid',
      },
      runtimeWorker: {
        activeColor: 'green',
        activeColorFile: '/etc/agent-saas/runtime-worker-active-color',
        unit: 'agent-saas-runtime-worker@green.service',
        releaseSymlink: '/opt/agent-saas-app/worker/green',
        releaseTarget: RELEASE_TARGET,
        pidfile: '/run/agent-saas-runtime-worker-green.pid',
        readyfile: '/run/agent-saas-runtime-worker-green.ready',
      },
    },
    ...overrides,
  };
}

function successfulGit(command, args) {
  assert.equal(command, 'git');
  if (args.includes('diff')) return 'web/src/App.tsx\nhand-server/src/worker.ts\n';
  return '';
}

function runtimeObservation(overrides = {}) {
  return {
    now: Date.parse('2026-08-25T00:01:00.000Z'),
    topologyExecFileSync: (_command, args) =>
      args.includes('ControlGroup') ? '/system.slice/agent-saas.service\n' : '123\n',
    topologyRealpathSync: () => RELEASE_TARGET,
    topologyReadFileSync: (path) => {
      if (path.endsWith('active-color')) return path.includes('runtime-worker') ? 'green' : 'blue';
      if (path.includes('/proc/')) return '0::/system.slice/agent-saas.service';
      return '123';
    },
    topologyProcessExists: () => true,
    ...overrides,
  };
}

test('preflight succeeds for full SHAs, main ancestry, production identity, and mapped changes', () => {
  const result = runPreflight({
    target: TARGET,
    baseline: BASELINE,
    identityPath: 'fixtures/production-runtime-identity.json',
    execFileSync: successfulGit,
    readFileSync: () => JSON.stringify(productionIdentity()),
    runtimeObservation: runtimeObservation(),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.affectedComponents, ['web', 'api', 'runtimeWorker']);
  assert.equal(result.components.web.action, 'deploy');
  assert.equal(result.components.api.action, 'deploy');
  assert.equal(result.workerMarkersConsistent, true);
  assert.equal(result.migrationPlan.phase, 'none');
  assert.equal(result.migrationPlan.contract, 'separate_release');
  assert.deepEqual(result.blockingReasons, []);
});

test('preflight pins ancestry to origin/main and ignores caller-selected refs', () => {
  const calls = [];
  runPreflight({
    target: TARGET,
    baseline: BASELINE,
    identityPath: './production.json',
    mainRef: TARGET,
    execFileSync: (command, args) => {
      calls.push([command, args]);
      return args.includes('diff') ? 'web/src/App.tsx\n' : '';
    },
    readFileSync: () => JSON.stringify(productionIdentity()),
    runtimeObservation: runtimeObservation(),
  });
  assert.deepEqual(calls[0]?.[1], ['merge-base', '--is-ancestor', TARGET, 'origin/main']);
});

test('preflight defaults to the trusted production-host identity path', () => {
  let observedPath;
  const result = runPreflight({
    target: TARGET,
    baseline: BASELINE,
    execFileSync: successfulGit,
    readFileSync: (path) => {
      observedPath = path;
      return JSON.stringify(productionIdentity());
    },
    runtimeObservation: runtimeObservation(),
  });
  assert.equal(result.ok, true);
  assert.equal(observedPath, TRUSTED_PRODUCTION_IDENTITY_PATH);
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
    return 'web/src/App.tsx\nunmapped-release-input.txt\n';
  };
  const identity = productionIdentity({ components: { web: { gitSha: TARGET } } });

  const result = runPreflight({
    target: TARGET,
    baseline: BASELINE,
    identityPath: 'fixtures/production-runtime-identity.json',
    execFileSync,
    readFileSync: () => JSON.stringify(identity),
    runtimeObservation: runtimeObservation(),
  });

  assert.equal(result.ok, false);
  assert.match(result.blockingReasons.join('\n'), /not reachable from origin\/main/u);
  assert.match(result.blockingReasons.join('\n'), /not an ancestor/u);
  assert.match(result.blockingReasons.join('\n'), /component "web" must have an ISO/u);
  assert.match(result.blockingReasons.join('\n'), /missing component "api"/u);
  assert.match(
    result.blockingReasons.join('\n'),
    /not mapped to a release component: unmapped-release-input.txt/u,
  );
});

test('preflight fails closed for conflicting production topology or component baseline', () => {
  const topologyConflict = productionIdentity({
    topology: {
      ...productionIdentity().topology,
      api: { ...productionIdentity().topology.api, pidfile: '/run/green-api.pid' },
    },
  });
  const conflict = runPreflight({
    target: TARGET,
    baseline: BASELINE,
    identityPath: './production.json',
    execFileSync: successfulGit,
    readFileSync: () => JSON.stringify(topologyConflict),
    runtimeObservation: runtimeObservation(),
  });
  assert.equal(conflict.ok, false);
  assert.match(conflict.blockingReasons.join('\n'), /pidfile conflicts with activeColor/u);
  const baselineConflict = productionIdentity({ gitSha: TARGET });
  const stale = runPreflight({
    target: TARGET,
    baseline: BASELINE,
    identityPath: './production.json',
    execFileSync: successfulGit,
    readFileSync: () => JSON.stringify(baselineConflict),
    runtimeObservation: runtimeObservation(),
  });
  assert.equal(stale.ok, false);
  assert.match(stale.blockingReasons.join('\n'), /does not match the supplied baseline/u);
});

test('runtime identity rejects placeholder topology fields', () => {
  const identity = productionIdentity({
    topology: {
      ...productionIdentity().topology,
      api: {
        unit: 'blue',
        releaseSymlink: 'blue',
        releaseTarget: 'blue',
        pidfile: 'blue',
        readyfile: 'blue',
      },
    },
  });
  const result = readRuntimeIdentity({
    identityPath: './production.json',
    readFileSync: () => JSON.stringify(identity),
    ...runtimeObservation(),
  });
  assert.equal(result.ok, false);
  assert.match(result.blockingReasons.join('\n'), /deployed systemd template/u);
  assert.match(result.blockingReasons.join('\n'), /absolute path/u);
});

test('runtime identity binds live symlinks to content-addressed release targets', () => {
  const identity = productionIdentity({
    topology: {
      ...productionIdentity().topology,
      api: {
        ...productionIdentity().topology.api,
        releaseTarget: `/opt/agent-saas-app/releases/${'d'.repeat(64)}`,
      },
    },
  });
  const result = readRuntimeIdentity({
    identityPath: './production.json',
    readFileSync: () => JSON.stringify(identity),
    ...runtimeObservation(),
  });
  assert.equal(result.ok, false);
  assert.match(
    result.blockingReasons.join('\n'),
    /releaseTarget does not match the deployed path/u,
  );
  assert.match(result.blockingReasons.join('\n'), /does not resolve to releaseTarget/u);
});

test('runtime identity fails closed for stale or unverifiable topology observations', () => {
  const staleIdentity = productionIdentity({
    topology: { ...productionIdentity().topology, observedAt: '2000-01-01T00:00:00.000Z' },
  });
  const stale = readRuntimeIdentity({
    identityPath: './production.json',
    readFileSync: () => JSON.stringify(staleIdentity),
    ...runtimeObservation(),
  });
  assert.equal(stale.ok, false);
  assert.match(stale.blockingReasons.join('\n'), /stale or in the future/u);

  const refreshedAt = Date.parse('2026-08-28T09:45:00.000Z');
  const refreshed = readRuntimeIdentity({
    identityPath: './production.json',
    readFileSync: () => JSON.stringify(staleIdentity),
    refreshTopologyObservation: true,
    ...runtimeObservation(),
    now: refreshedAt,
  });
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.identity.topology.observedAt, new Date(refreshedAt).toISOString());

  const staleColorIdentity = productionIdentity({
    topology: {
      ...productionIdentity().topology,
      api: {
        ...productionIdentity().topology.api,
        activeColor: 'green',
        unit: 'agent-saas-server@green.service',
        releaseSymlink: '/opt/agent-saas-app/color/green',
        pidfile: '/run/agent-saas-server-green.pid',
      },
      runtimeWorker: {
        ...productionIdentity().topology.runtimeWorker,
        activeColor: 'blue',
        unit: 'agent-saas-runtime-worker@blue.service',
        releaseSymlink: '/opt/agent-saas-app/worker/blue',
        pidfile: '/run/agent-saas-runtime-worker-blue.pid',
        readyfile: '/run/agent-saas-runtime-worker-blue.ready',
      },
    },
  });
  const refreshedColors = readRuntimeIdentity({
    identityPath: './production.json',
    readFileSync: () => JSON.stringify(staleColorIdentity),
    refreshTopologyObservation: true,
    ...runtimeObservation(),
    now: refreshedAt,
  });
  assert.equal(refreshedColors.ok, true);
  assert.equal(refreshedColors.identity.topology.api.activeColor, 'blue');
  assert.equal(refreshedColors.identity.topology.runtimeWorker.activeColor, 'green');
  assert.equal(refreshedColors.identity.topology.api.unit, 'agent-saas-server@blue.service');
  assert.equal(
    refreshedColors.identity.topology.runtimeWorker.readyfile,
    '/run/agent-saas-runtime-worker-green.ready',
  );

  const refreshedButUnverifiable = readRuntimeIdentity({
    identityPath: './production.json',
    readFileSync: () => JSON.stringify(staleIdentity),
    refreshTopologyObservation: true,
    ...runtimeObservation({
      topologyProcessExists: () => false,
    }),
    now: refreshedAt,
  });
  assert.equal(refreshedButUnverifiable.ok, false);
  assert.equal(refreshedButUnverifiable.identity.topology.observedAt, '2000-01-01T00:00:00.000Z');
  assert.match(refreshedButUnverifiable.blockingReasons.join('\n'), /live process/u);

  const missing = readRuntimeIdentity({
    identityPath: './production.json',
    readFileSync: () => JSON.stringify(productionIdentity()),
    ...runtimeObservation({
      topologyExecFileSync: () => {
        throw new Error('unit absent');
      },
      topologyRealpathSync: () => {
        throw new Error('symlink absent');
      },
      topologyReadFileSync: () => {
        throw new Error('file absent');
      },
    }),
  });
  assert.equal(missing.ok, false);
  assert.match(missing.blockingReasons.join('\n'), /Unable to observe systemd process identity/u);
  assert.match(missing.blockingReasons.join('\n'), /Unable to resolve production release symlink/u);
  assert.match(missing.blockingReasons.join('\n'), /Unable to read production pidfile/u);
  assert.match(missing.blockingReasons.join('\n'), /Unable to read production readyfile/u);
});

test('runtime identity requires pidfile PID to equal systemd MainPID', () => {
  const result = readRuntimeIdentity({
    identityPath: './production.json',
    readFileSync: () => JSON.stringify(productionIdentity()),
    ...runtimeObservation({
      topologyExecFileSync: (_command, args) =>
        args.includes('ControlGroup') ? '/system.slice/agent-saas.service\n' : '456\n',
    }),
  });
  assert.equal(result.ok, false);
  assert.match(
    result.blockingReasons.join('\n'),
    /pidfile PID must equal the live systemd MainPID/u,
  );
});

test('runtime identity accepts only local, complete production JSON', () => {
  const valid = readRuntimeIdentity({
    identityPath: './production.json',
    readFileSync: () => JSON.stringify(productionIdentity()),
    ...runtimeObservation(),
  });
  assert.equal(valid.ok, true);

  const invalidJson = readRuntimeIdentity({
    identityPath: './production.json',
    readFileSync: () => '{',
  });
  assert.equal(invalidJson.ok, false);
  assert.match(invalidJson.blockingReasons[0], /Unable to read production runtime identity JSON/u);
});
