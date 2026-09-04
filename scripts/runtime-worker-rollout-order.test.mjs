import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const compatibilityAuthority = readFileSync(
  new URL('./release/compat-app-authority.sh', import.meta.url),
  'utf8',
);
const rollbackHelper = readFileSync(
  new URL('./release/production-deploy-rollback.sh', import.meta.url),
  'utf8',
);
const preflight = readFileSync(new URL('./pr-preflight-task.sh', import.meta.url), 'utf8');

function position(text, sourceOrStart = workflow) {
  const source = typeof sourceOrStart === 'number' ? workflow : sourceOrStart;
  const start = typeof sourceOrStart === 'number' ? sourceOrStart : 0;
  const index = source.indexOf(text, start);
  assert.notEqual(index, -1, `missing marker: ${text}`);
  return index;
}

test('compatibility deploy publishes a self-contained rollback before App mutation', () => {
  const pendingRecovery = position('pending compatibility attempt detected before active validation');
  const activeValidation = position('if ! systemctl is-active --quiet "${SERVICE_NAME}@${ACTIVE}"');
  const sourceAuthority = position('source "$RELEASE_DIR/scripts/release/compat-app-authority.sh"');
  const publishRollback = position('publish_compat_deploy_rollback', sourceAuthority);
  const overwriteApiUnit = position(
    'install -m 0644 "$RELEASE_DIR/daemon-packaging/systemd/agent-saas-server@.service.template"',
  );
  const switchIdle = position('ln -sfn "$RELEASE_DIR" "$COLOR_DIR/$IDLE"');
  const rollbackStart = position('rollback_idle_and_exit()');
  const rollbackEnd = workflow.indexOf('recover_interrupted_runtime_worker_drain()', rollbackStart);
  const rollbackBlock = workflow.slice(rollbackStart, rollbackEnd);

  assert.ok(pendingRecovery < activeValidation);
  assert.ok(sourceAuthority < publishRollback);
  assert.ok(publishRollback < overwriteApiUnit);
  assert.ok(publishRollback < switchIdle);
  assert.match(rollbackBlock, /restore_pre_drained_legacy_runtime/u);
  assert.match(rollbackBlock, /compat-deploy-attempt-current/u);
  assert.match(rollbackBlock, /COMPAT_ROLLBACK_STATE_DIR/u);

  for (const marker of [
    'API_UNIT_EXISTED',
    'WORKER_UNIT_EXISTED',
    'NGINX_DROPIN_EXISTED',
    'API_RELEASE_ENV_EXISTED',
    'WORKER_RELEASE_ENV_EXISTED',
    'API_PRIVATE_SNAPSHOT_EXISTED',
    'WORKER_PRIVATE_SNAPSHOT_EXISTED',
    'RUNTIME_IDENTITY_EXISTED',
    'API_OLD_ENABLEMENT',
    'WORKER_NEW_ENABLEMENT',
  ]) {
    assert.match(compatibilityAuthority, new RegExp(marker, 'u'));
  }
  assert.match(compatibilityAuthority, /source "\$STATE\/compat-app-authority\.sh"/u);
  assert.match(rollbackHelper, /declare -F rollback_idle_and_exit/u);
  assert.match(rollbackHelper, /production_deploy_rollback/u);
  assert.match(workflow, /source "\$RELEASE_DIR\/scripts\/release\/production-deploy-rollback\.sh"/u);
});

test('API and Worker compatibility markers commit through one App generation', () => {
  const oldGeneration = position('generation-old.XXXXXX', compatibilityAuthority);
  const migrateApiMarker = position('ln -s "$authority_link/api"', compatibilityAuthority);
  const migrateWorkerMarker = position('ln -s "$authority_link/worker"', compatibilityAuthority);
  const newGeneration = position('generation.XXXXXX', compatibilityAuthority);
  const commitComment = position('This rename is the only new-authority commit', compatibilityAuthority);
  const authorityCommit = compatibilityAuthority.indexOf(
    'mv -fT "$link_candidate" "$authority_link"',
    commitComment,
  );
  const removeAbsentWorker = position('rm -f "$worker_marker"', compatibilityAuthority);

  assert.ok(oldGeneration < migrateApiMarker);
  assert.ok(migrateApiMarker < migrateWorkerMarker);
  assert.ok(migrateWorkerMarker < newGeneration);
  assert.ok(newGeneration < authorityCommit);
  assert.ok(authorityCommit < removeAbsentWorker);
  assert.equal(workflow.includes('write_worker_active_color "$WORKER_IDLE"'), false);
  assert.match(workflow, /commit_app_active_colors "\$IDLE" "\$APP_WORKER_TARGET"/u);
});

test('rollback stops the candidate Worker before preparing old processes and restoring authority', () => {
  const rollbackTemplate = position(
    'cat >"$state_build/rollback.sh" <<\'ROLLBACK\'',
    compatibilityAuthority,
  );
  const rollback = compatibilityAuthority.slice(rollbackTemplate);
  const candidateWorkerStop = position(
    'systemctl disable --now "$WORKER_SERVICE@$WORKER_NEW_COLOR"',
    rollback,
  );
  const apiRestart = position('systemctl restart "$SERVICE@$API_OLD_COLOR"', rollback);
  const workerRestart = position('systemctl restart "$WORKER_SERVICE@$WORKER_OLD_COLOR"', rollback);
  const oldAuthority = position(
    'commit_compat_app_active_colors "$API_OLD_COLOR" "$WORKER_OLD_COLOR"',
    rollback,
  );
  const nginxReload = rollback.indexOf('systemctl reload nginx', oldAuthority);
  const candidateApiStop = rollback.indexOf('systemctl disable --now "$SERVICE@$API_NEW_COLOR"', nginxReload);

  assert.ok(candidateWorkerStop < apiRestart);
  assert.ok(candidateWorkerStop < workerRestart);
  assert.ok(apiRestart < oldAuthority);
  assert.ok(workerRestart < oldAuthority);
  assert.ok(oldAuthority < nginxReload);
  assert.ok(nginxReload < candidateApiStop);
  assert.match(
    rollback,
    /WORKER_OLD_COLOR" = absent[\s\S]*! -L "\$WORKER_ACTIVE_COLOR_FILE"/u,
  );
});

test('legacy runtime exits before candidate start while fenced runtime stages the candidate', () => {
  const capabilityCheck = position(
    'if [ ! -f "$LEGACY_RUNTIME_TARGET/.release/runtime-worker-execution-fencing-v1" ]',
  );
  const deploymentBudgetGuard = position(
    'insufficient remote deployment budget for legacy drain; rolling back before signal',
  );
  const legacyWorkerExit = position('legacy runtime worker exited before candidate start');
  const legacyAllExit = position('legacy bootstrap all exited before candidate start');
  const configIdentityEnvGuard = position(
    'if ! node "$RELEASE_DIR/scripts/release/write-compatibility-app-env.mjs"',
  );
  const candidateMarkerGuard = position(
    'if ! rm -f "/run/agent-saas-runtime-worker-${WORKER_IDLE}.pid"',
  );
  const candidateStart = position('systemctl enable --now "${WORKER_SERVICE}@${WORKER_IDLE}"');

  assert.ok(capabilityCheck < deploymentBudgetGuard);
  assert.ok(deploymentBudgetGuard < legacyWorkerExit);
  assert.ok(deploymentBudgetGuard < legacyAllExit);
  assert.ok(legacyWorkerExit < configIdentityEnvGuard);
  assert.ok(legacyAllExit < configIdentityEnvGuard);
  assert.ok(configIdentityEnvGuard < candidateMarkerGuard);
  assert.ok(candidateMarkerGuard < candidateStart);
  assert.ok(workflow.includes('LEGACY_DRAIN_DEADLINE_EPOCH=$((START_EPOCH + 1600))'));
  assert.ok(workflow.includes('graceful drain timed out; forcing rollback before remote timeout'));
  assert.ok(workflow.includes('active runtime supports execution fencing; candidate-first handoff is allowed'));
});

test('candidate readiness and Web readiness precede the joint API/Worker authority commit', () => {
  const candidateReady = position('WORKER_PROCESS_READY=1');
  const workerPrepared = position('runtime worker prepared without authority commit');
  const webStart = position('start idle unit: ${SERVICE_NAME}@${IDLE}');
  const webReady = position('waiting ready: $READY_URL timeout=180s');
  const nginxCandidate = position('rewrite nginx upstream: primary=127.0.0.1:$IDLE_PORT');
  const nginxTest = position('if ! nginx -t; then', nginxCandidate);
  const appCommit = position('if ! commit_app_active_colors "$IDLE" "$APP_WORKER_TARGET"', nginxTest);
  const nginxReload = position('if ! systemctl reload nginx; then', appCommit);
  const refreshCall = position('if ! refresh_worker_candidate_authority; then', appCommit);

  assert.ok(candidateReady < workerPrepared);
  assert.ok(workerPrepared < webStart);
  assert.ok(webStart < webReady);
  assert.ok(webReady < nginxCandidate);
  assert.ok(nginxCandidate < nginxTest);
  assert.ok(nginxTest < appCommit);
  assert.ok(appCommit < nginxReload);
  assert.ok(nginxReload < refreshCall);
  assert.equal(workflow.includes('WORKER_V3_'), false);
  assert.ok(workflow.includes('runtime-worker-execution-fencing-v1'));
});

test('standard preflight executes Release contracts and compatibility authority regressions', () => {
  assert.match(preflight, /pnpm test:release-contracts/u);
  assert.match(preflight, /bash scripts\/release\/compat-app-authority\.test\.sh/u);
});
