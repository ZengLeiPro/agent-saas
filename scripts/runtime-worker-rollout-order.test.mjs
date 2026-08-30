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
  assert.ok(workflow.includes('bootstrap all cannot reclaim runtime retention authority; preserving candidate'));
  assert.ok(workflow.includes('bootstrap all authority reclaim timed out; preserving candidate'));
  assert.ok(workflow.includes('recover interrupted runtime worker drain before rollout'));
  assert.ok(workflow.includes('runtime worker marker target is ready and enabled'));
  assert.ok(workflow.includes('failed to disable non-marker runtime worker candidate'));
  assert.ok(workflow.includes('interrupted runtime worker candidate drained after active recovery'));
  assert.ok(position('interrupted runtime worker drain recovered: color=$color')
    < position('interrupted runtime worker candidate drained after active recovery'));
  assert.equal(workflow.split('recover_interrupted_runtime_worker_drain "$WORKER_ACTIVE"').length - 1, 2);
  assert.equal(workflow.includes('WORKER_ACTIVE_DRAINED'), false);
});

test('bootstrap rollback restores the serving all process authority before candidate stop', () => {
  const restoreFunction = position('restore_bootstrap_all_authority()');
  const restoreSignal = workflow.indexOf('kill -HUP "$bootstrap_all_pid"', restoreFunction);
  const restoreAck = workflow.indexOf('bootstrap all runtime retention authority reclaimed before candidate stop', restoreFunction);
  const rollbackStart = position('rollback_idle_and_exit()');
  const bootstrapGuard = workflow.indexOf('[ -z "${WORKER_ACTIVE:-}" ]', rollbackStart);
  const restoreCall = workflow.indexOf('\n              restore_bootstrap_all_authority\n', rollbackStart);
  const bootstrapMarkerRemoval = workflow.indexOf('remove bootstrap runtime worker authority before candidate stop', rollbackStart);
  const candidateStop = workflow.indexOf('stop runtime worker candidate:', rollbackStart);

  assert.ok(restoreSignal > restoreFunction);
  assert.ok(restoreSignal < restoreAck);
  assert.ok(bootstrapGuard > rollbackStart);
  assert.ok(restoreCall > bootstrapGuard);
  assert.ok(restoreCall < bootstrapMarkerRemoval);
  assert.ok(bootstrapMarkerRemoval < candidateStop);
});

test('legacy runtime sources exit before an execution-fencing candidate can start', () => {
  const capabilityCheck = position('if [ ! -f "$LEGACY_RUNTIME_TARGET/.release/runtime-worker-execution-fencing-v1" ]');
  const deploymentBudgetGuard = position('insufficient remote deployment budget for legacy drain; rolling back before signal');
  const legacyWorkerExit = position('legacy runtime worker exited before candidate start');
  const legacyAllExit = position('legacy bootstrap all exited before candidate start');
  const compatibilityEnvGuard = position('if ! node "$RELEASE_DIR/scripts/release/write-compatibility-app-env.mjs"');
  const candidateMarkerGuard = position('if ! rm -f "/run/agent-saas-runtime-worker-${WORKER_IDLE}.pid"');
  const candidateStart = position('systemctl enable --now "${WORKER_SERVICE}@${WORKER_IDLE}"');
  const rollbackCandidateStop = position('stop runtime worker candidate before legacy rollback');
  const rollbackWorkerTemplate = position('legacy_worker_target/daemon-packaging/systemd/agent-saas-runtime-worker@.service.template');
  const rollbackWorkerRestore = position('legacy runtime worker and its service template restored only after candidate stop');
  const rollbackAllTemplate = position('legacy_bootstrap_target/daemon-packaging/systemd/agent-saas-server@.service.template');
  const rollbackAllRestore = position('legacy bootstrap all and its service template restored only after candidate stop');

  assert.ok(capabilityCheck < deploymentBudgetGuard);
  assert.ok(deploymentBudgetGuard < legacyWorkerExit);
  assert.ok(deploymentBudgetGuard < legacyAllExit);
  assert.ok(legacyWorkerExit < compatibilityEnvGuard);
  assert.ok(legacyAllExit < compatibilityEnvGuard);
  assert.ok(compatibilityEnvGuard < candidateMarkerGuard);
  assert.ok(candidateMarkerGuard < candidateStart);
  assert.ok(rollbackCandidateStop < rollbackWorkerTemplate);
  assert.ok(rollbackWorkerTemplate < rollbackWorkerRestore);
  assert.ok(rollbackCandidateStop < rollbackAllTemplate);
  assert.ok(rollbackAllTemplate < rollbackAllRestore);
  assert.ok(workflow.includes('LEGACY_DRAIN_DEADLINE_EPOCH=$((START_EPOCH + 1600))'));
  assert.ok(workflow.includes('graceful drain timed out; forcing rollback before remote timeout'));
  assert.ok(workflow.includes('failed to write compatibility env after runtime preflight'));
  assert.ok(workflow.includes('failed to clear candidate runtime markers'));
  assert.ok(workflow.includes('failed to arm active runtime worker drain guard'));
  assert.ok(workflow.includes('previous runtime service template and enablement restored before rollback'));
  assert.ok(workflow.includes('active runtime supports execution fencing; candidate-first handoff is allowed'));
});

test('runtime worker candidate authority and post-drain refresh precede Web readiness', () => {
  const candidateReady = position('WORKER_PROCESS_READY=1');
  const workerAuthority = position('runtime worker authority promoted before old drain');
  const workerDrain = workflow.indexOf('kill -USR2 "$OLD_WORKER_PID"', workerAuthority);
  const authorityRefresh = position('runtime worker authority refreshed after old drain');
  const workerHandoff = position('runtime worker handoff completed before Web readiness');
  const webStart = position('start idle unit: ${SERVICE_NAME}@${IDLE}');
  const webReady = position('waiting ready: $READY_URL timeout=180s');
  const trafficSwitch = position('rewrite nginx upstream: primary=127.0.0.1:$IDLE_PORT');

  assert.ok(candidateReady < workerAuthority);
  assert.ok(workerDrain > workerAuthority);
  assert.ok(workerDrain < authorityRefresh);
  assert.ok(authorityRefresh < workerHandoff);
  assert.ok(workerHandoff < webStart);
  assert.ok(webStart < webReady);
  assert.ok(webReady < trafficSwitch);
  assert.equal(workflow.includes('integrationV3ControlPlane'), false);
  assert.equal(workflow.includes('integration_activation_heartbeats_v3'), false);
  assert.equal(workflow.includes('WORKER_V3_'), false);
  assert.equal(workflow.includes('start deferred until Web cutover succeeds'), false);
  assert.ok(workflow.includes('runtime-worker-execution-fencing-v1'));
});
