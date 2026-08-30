import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

function position(text) {
  const index = workflow.indexOf(text);
  assert.notEqual(index, -1, `missing workflow marker: ${text}`);
  return index;
}

test('runtime worker rollback restores drained authority before candidate stop', () => {
  const drainStarted = position('WORKER_ACTIVE_DRAIN_STARTED=1');
  const drainSignal = position('kill -USR2 "$OLD_WORKER_PID"');
  const drainCompleted = position('WORKER_ACTIVE_DRAIN_COMPLETED=1');
  const rollbackStart = position('rollback_idle_and_exit()');
  const restoreAuthority = workflow.indexOf('write_worker_active_color "$WORKER_ACTIVE"', rollbackStart);
  const restoreRestart = workflow.indexOf('systemctl restart "${WORKER_SERVICE}@${WORKER_ACTIVE}"', rollbackStart);
  const restoreReady = workflow.indexOf('previous runtime worker marker restored before candidate stop', rollbackStart);
  const candidateStop = workflow.indexOf('stop runtime worker candidate:', rollbackStart);

  assert.ok(drainStarted < drainSignal);
  assert.ok(drainSignal < drainCompleted);
  assert.ok(restoreRestart > rollbackStart);
  assert.ok(restoreRestart < restoreAuthority);
  assert.ok(restoreAuthority < restoreReady);
  assert.ok(restoreReady < candidateStop);
  assert.ok(workflow.includes('WORKER_DRAIN_TIMEOUT=960'));
  assert.ok(workflow.includes('preserving candidate and refusing restart'));
  assert.ok(workflow.includes('recover interrupted runtime worker drain before rollout'));
  assert.ok(workflow.includes('runtime worker marker target is ready and enabled'));
  assert.ok(workflow.includes('failed to disable non-marker runtime worker candidate'));
  assert.ok(workflow.includes('interrupted runtime worker candidate drained after active recovery'));
  assert.ok(position('interrupted runtime worker drain recovered: color=$color')
    < position('interrupted runtime worker candidate drained after active recovery'));
  assert.equal(workflow.split('recover_interrupted_runtime_worker_drain "$WORKER_ACTIVE"').length - 1, 2);
  assert.equal(workflow.includes('WORKER_ACTIVE_DRAINED'), false);
});

test('runtime worker candidate authority and post-drain refresh precede Web readiness', () => {
  const candidateReady = position('WORKER_PROCESS_READY=1');
  const workerAuthority = position('runtime worker authority promoted before old drain');
  const workerDrain = position('kill -USR2 "$OLD_WORKER_PID"');
  const authorityRefresh = position('runtime worker authority refreshed after old drain');
  const workerHandoff = position('runtime worker handoff completed before Web readiness');
  const webStart = position('start idle unit: ${SERVICE_NAME}@${IDLE}');
  const webReady = position('waiting ready: $READY_URL timeout=180s');
  const trafficSwitch = position('rewrite nginx upstream: primary=127.0.0.1:$IDLE_PORT');

  assert.ok(candidateReady < workerAuthority);
  assert.ok(workerAuthority < workerDrain);
  assert.ok(workerDrain < authorityRefresh);
  assert.ok(authorityRefresh < workerHandoff);
  assert.ok(workerHandoff < webStart);
  assert.ok(webStart < webReady);
  assert.ok(webReady < trafficSwitch);
  assert.equal(workflow.includes('integrationV3ControlPlane'), false);
  assert.equal(workflow.includes('integration_activation_heartbeats_v3'), false);
  assert.equal(workflow.includes('WORKER_V3_'), false);
  assert.equal(workflow.includes('start deferred until Web cutover succeeds'), false);
});
