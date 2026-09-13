import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyRetirementGate } from './app-retirement-verify-gate.mjs';

const digest = 'sha256:' + 'a'.repeat(64);
const manifest = { releaseId: 'rc-20260912-131', digest };
const targets = {
  targetDigest: 'd1c9edc78e9a838403eadb737e465b8e33324faf175eaf8639114e4c3657cdf2',
};

const rc131Observation = {
  schemaVersion: 1,
  releaseId: 'rc-20260912-131',
  manifestDigest: digest,
  targetDigest: targets.targetDigest,
  status: 'needs_human',
  retirementPhase: 'draining_or_unverified',
  components: [
    {
      role: 'api',
      color: 'blue',
      pid: 1690681,
      phase: 'completed',
      acknowledged: true,
      durable: { total: 0, terminal: 0, unverified: 0, verified: true },
    },
    {
      role: 'runtimeWorker',
      color: 'blue',
      pid: 1690144,
      phase: 'needs_human',
      acknowledged: false,
      durable: { total: 0, terminal: 0, unverified: 0, verified: true },
    },
  ],
};

const rc131Live = {
  runtimeWorker: {
    activeState: 'inactive',
    unitFileState: 'disabled',
    mainPid: 0,
    result: 'success',
    processGone: true,
  },
  markers: {
    runtimeWorker: {
      pid: 1690144,
      activeStreams: 0,
      activeUploads: 0,
      runtimeQuiesced: false,
      drainState: 'failed',
      reason: 'shutdown_cleanup_failed',
      registeredRuns: 0,
      inventoryComplete: true,
      drainRuns: [],
    },
  },
};

test('acknowledged observation passes', () => {
  const result = classifyRetirementGate({
    observation: { ...rc131Observation, status: 'acknowledged' },
    manifest,
    targets,
    live: rc131Live,
  });
  assert.deepEqual(result, { verdict: 'ok', reason: 'acknowledged' });
});

test('RC131 cleanup-timeout marker with dead disabled unit is accepted', () => {
  const result = classifyRetirementGate({
    observation: rc131Observation,
    manifest,
    targets,
    live: rc131Live,
  });
  assert.deepEqual(result, { verdict: 'ok', reason: 'cleanup_failed_after_drain_complete' });
});

test('failed marker with remaining drain runs stays fail-closed', () => {
  const result = classifyRetirementGate({
    observation: rc131Observation,
    manifest,
    targets,
    live: {
      ...rc131Live,
      markers: {
        runtimeWorker: {
          ...rc131Live.markers.runtimeWorker,
          drainRuns: [{ runId: 'run-1', workerId: 'w', tenantId: 't' }],
        },
      },
    },
  });
  assert.equal(result.verdict, 'fail');
});

test('failed marker while the unit is still active stays fail-closed', () => {
  const result = classifyRetirementGate({
    observation: rc131Observation,
    manifest,
    targets,
    live: {
      ...rc131Live,
      runtimeWorker: {
        ...rc131Live.runtimeWorker,
        activeState: 'active',
        mainPid: 1690144,
        processGone: false,
      },
    },
  });
  assert.equal(result.verdict, 'fail');
});

test('unbound observation fails closed', () => {
  const result = classifyRetirementGate({
    observation: rc131Observation,
    manifest: { releaseId: 'other', digest },
    targets,
    live: rc131Live,
  });
  assert.deepEqual(result, { verdict: 'fail', reason: 'observation_not_bound' });
});

test('still-draining generation is retryable', () => {
  const result = classifyRetirementGate({
    observation: {
      ...rc131Observation,
      components: [
        rc131Observation.components[0],
        { ...rc131Observation.components[1], phase: 'draining' },
      ],
    },
    manifest,
    targets,
    live: {
      runtimeWorker: {
        activeState: 'active',
        unitFileState: 'disabled',
        mainPid: 42,
        result: 'success',
        processGone: false,
      },
      markers: {
        runtimeWorker: {
          drainState: 'draining',
          drainRuns: [],
          activeStreams: 0,
          activeUploads: 0,
        },
      },
    },
  });
  assert.deepEqual(result, { verdict: 'retryable', reason: 'still_draining' });
});
