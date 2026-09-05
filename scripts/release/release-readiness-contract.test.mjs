import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  readReleaseConfigIdentityBinding,
  validateCandidateReleaseReadiness,
  validatePrivateConfigIdentityReleaseBinding,
} from './read-production-state.mjs';

const fixture = async (name) =>
  JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const expectedConfigIdentity = {
  schemaVersion: 1,
  digest: `sha256:${'c'.repeat(64)}`,
  credentialVersionDigest: null,
  versionResolution: 'resolved',
  secretRefCount: 0,
};

test('real anonymous readiness fixtures stay summary-free and validate against private snapshots', async () => {
  const manifest = await fixture('candidate-manifest.json');
  const privateSnapshotPath = new URL('./fixtures/candidate-config-identity.json', import.meta.url);
  for (const environment of ['production', 'staging']) {
    const readiness = await fixture(`${environment}-readiness.json`);
    assert.equal(Object.hasOwn(readiness, 'configIdentity'), false);
    assert.equal(expectedConfigIdentity.versionResolution, 'resolved');
    const summary = await validateCandidateReleaseReadiness({
      environment,
      manifest,
      readiness,
      privateSnapshotPath,
      expectedConfigIdentity,
    });
    assert.equal(summary.status, 'consistent');
  }
});

test('candidate contract rejects anonymous summary leaks and deployment/snapshot disagreement', async () => {
  const manifest = await fixture('candidate-manifest.json');
  const readiness = await fixture('production-readiness.json');
  const privateSnapshotPath = new URL('./fixtures/candidate-config-identity.json', import.meta.url);
  await assert.rejects(
    validateCandidateReleaseReadiness({
      environment: 'production',
      manifest,
      readiness: { ...readiness, configIdentity: await fixture('candidate-config-identity.json') },
      privateSnapshotPath,
      expectedConfigIdentity,
    }),
    /must not expose ConfigIdentity summary/,
  );
  await assert.rejects(
    validateCandidateReleaseReadiness({
      environment: 'production',
      manifest,
      readiness: {
        ...readiness,
        release: {
          ...readiness.release,
          expectedConfigIdentity: {
            ...expectedConfigIdentity,
            credentialVersionDigest: `sha256:${'d'.repeat(64)}`,
          },
        },
      },
      privateSnapshotPath,
      expectedConfigIdentity,
    }),
    /must not expose ConfigIdentity summary/,
  );
  await assert.rejects(
    validateCandidateReleaseReadiness({
      environment: 'production',
      manifest,
      readiness,
      privateSnapshotPath,
      expectedConfigIdentity: {
        ...expectedConfigIdentity,
        digest: `sha256:${'f'.repeat(64)}`,
      },
    }),
    /disagrees with deployment/,
  );
});

test('private ConfigIdentity release helper compares fields and rejects fail-closed snapshots', async () => {
  const summary = await fixture('candidate-config-identity.json');
  const dir = await mkdtemp(join(tmpdir(), 'worker-config-identity-binding-'));
  const privateSnapshotPath = join(dir, 'worker.json');
  try {
    await writeFile(privateSnapshotPath, JSON.stringify(summary));
    await assert.doesNotReject(
      validatePrivateConfigIdentityReleaseBinding({
        privateSnapshotPath,
        releaseId: summary.releaseId,
        expectedConfigIdentity,
        label: 'Candidate Worker private ConfigIdentity',
      }),
    );

    const mismatches = [
      ['releaseId', { releaseId: 'rc-wrong' }, /not consistent with the release binding/],
      [
        'schemaVersion',
        { expectedConfigIdentity: { ...expectedConfigIdentity, schemaVersion: 2 } },
        /expected schemaVersion disagrees with deployment/,
      ],
      [
        'digest',
        {
          expectedConfigIdentity: {
            ...expectedConfigIdentity,
            digest: `sha256:${'f'.repeat(64)}`,
          },
        },
        /expected digest disagrees with deployment/,
      ],
      [
        'credentialVersionDigest',
        {
          expectedConfigIdentity: {
            ...expectedConfigIdentity,
            credentialVersionDigest: `sha256:${'d'.repeat(64)}`,
          },
        },
        /expected credentialVersionDigest disagrees with deployment/,
      ],
    ];
    for (const [field, overrides, expectedError] of mismatches) {
      await assert.rejects(
        validatePrivateConfigIdentityReleaseBinding({
          privateSnapshotPath,
          releaseId: summary.releaseId,
          expectedConfigIdentity,
          label: 'Candidate Worker private ConfigIdentity',
          ...overrides,
        }),
        expectedError,
        field,
      );
    }

    for (const unavailableSummary of [
      {
        schemaVersion: 1,
        status: 'unverifiable',
        reason: 'expected_not_bound',
        releaseId: summary.releaseId,
        observed: summary.observed,
      },
      {
        schemaVersion: 1,
        status: 'not_collected',
        releaseId: summary.releaseId,
      },
    ]) {
      await writeFile(privateSnapshotPath, JSON.stringify(unavailableSummary));
      await assert.rejects(
        validatePrivateConfigIdentityReleaseBinding({
          privateSnapshotPath,
          releaseId: summary.releaseId,
          expectedConfigIdentity,
        }),
        /not consistent with the release binding/,
      );
    }

    await rm(privateSnapshotPath);
    await assert.rejects(
      validatePrivateConfigIdentityReleaseBinding({
        privateSnapshotPath,
        releaseId: summary.releaseId,
        expectedConfigIdentity,
      }),
      /ENOENT/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rollback release env is parsed without shell evaluation and must match the old Worker snapshot', async () => {
  const summary = await fixture('candidate-config-identity.json');
  const dir = await mkdtemp(join(tmpdir(), 'rollback-worker-binding-'));
  const envPath = join(dir, 'runtime-worker-blue.release.env');
  const privateSnapshotPath = join(dir, 'worker.json');
  try {
    await writeFile(privateSnapshotPath, JSON.stringify(summary));
    await writeFile(envPath, [
      `AGENT_SAAS_RELEASE_ID=${summary.releaseId}`,
      `AGENT_SAAS_CONFIG_IDENTITY_SCHEMA_VERSION=${summary.expected.schemaVersion}`,
      `AGENT_SAAS_CONFIG_IDENTITY_DIGEST=${summary.expected.digest}`,
      '',
    ].join('\n'));
    const binding = await readReleaseConfigIdentityBinding(envPath);
    await assert.doesNotReject(validatePrivateConfigIdentityReleaseBinding({
      privateSnapshotPath,
      ...binding,
      label: 'Rollback Worker private ConfigIdentity',
    }));

    await writeFile(envPath, [
      `AGENT_SAAS_RELEASE_ID=${summary.releaseId}`,
      `AGENT_SAAS_CONFIG_IDENTITY_SCHEMA_VERSION=${summary.expected.schemaVersion}`,
      `AGENT_SAAS_CONFIG_IDENTITY_DIGEST=sha256:${'f'.repeat(64)}`,
      '',
    ].join('\n'));
    await assert.rejects(
      validatePrivateConfigIdentityReleaseBinding({
        privateSnapshotPath,
        ...await readReleaseConfigIdentityBinding(envPath),
        label: 'Rollback Worker private ConfigIdentity',
      }),
      /expected digest disagrees with deployment/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Production and Staging deploy modules enforce atomic App topology and private snapshot commit boundaries', async () => {
  const [production, staging, healthRoute, adminConfigMutation] = await Promise.all([
    readFile(new URL('./deploy-production-release.sh', import.meta.url), 'utf8'),
    readFile(new URL('./deploy-staging-release.sh', import.meta.url), 'utf8'),
    readFile(new URL('../../server/src/routes/health.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../server/src/config/adminConfigMutationService.ts', import.meta.url), 'utf8'),
  ]);
  for (const deploy of [production, staging]) {
    assert.match(deploy, /validateCandidateReleaseReadiness/u);
    assert.doesNotMatch(deploy, /(?:ready|api)\.configIdentity/u);
  }
  const workerPidCheck = production.indexOf(
    'pid="$(cat "$run_root/agent-saas-runtime-worker-$color.pid"',
  );
  const workerEnvironmentCheck = production.indexOf(
    'systemctl show "agent-saas-runtime-worker@$color" --property Environment --value',
  );
  assert.ok(workerPidCheck > -1);
  assert.ok(workerEnvironmentCheck > workerPidCheck);
  assert.match(production, /privateSnapshotPath: snapshotPath/u);
  assert.match(production, /readReleaseConfigIdentityBinding/u);
  assert.match(production, /runtime_data_root\/config-governance\/config\.lock/u);
  assert.match(production, /CONFIG_GOVERNANCE_FENCE_OWNER/u);
  assert.match(production, /config\.lock\.guard/u);
  assert.match(production, /flock -n "\$guard_fd"/u);
  const cleanupLifecycle = production.slice(
    production.indexOf('deploy_rollback_cleanup() {'),
    production.indexOf('# END deploy rollback cleanup lifecycle'),
  );
  assert.ok(
    cleanupLifecycle.indexOf('"$rollback_handler"')
      < cleanupLifecycle.indexOf('release_config_governance_fence'),
  );
  assert.match(adminConfigMutation, /acquireFileGuard/u);
  assert.match(adminConfigMutation, /isProcessAlive\(owner\?\.pid\)/u);
  assert.match(production, /\.owner-token/u);
  assert.match(
    production,
    /agent-saas-production-before-\$\{PHASE\}-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}\.json/u,
  );
  assert.match(
    production,
    /acs-promotion-health-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}\.json/u,
  );
  assert.match(
    production,
    /api-candidate-ready-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}\.json/u,
  );
  assert.match(
    production,
    /cat "\$fence\/\.owner-token"[\s\S]*= "\$owner"[\s\S]*rm -rf "\$fence"/u,
  );
  assert.match(production, /"token":"%s"/u);
  assert.doesNotMatch(production, /\/tmp\/api-candidate-ready\.json/u);
  assert.doesNotMatch(production, /\/tmp\/acs-promotion-health\.json/u);
  const workerValidator = production.slice(
    production.indexOf('validate_worker_release_boundary() {'),
    production.indexOf('revoke_systemd_authority() {'),
  );
  assert.ok(
    workerValidator.lastIndexOf('systemctl is-active --quiet')
      > workerValidator.indexOf("await validatePrivateConfigIdentityReleaseBinding"),
  );
  assert.match(workerValidator, /systemctl is-enabled --quiet/u);
  const apiValidator = production.slice(
    production.indexOf('validate_api_release_boundary() {'),
    production.indexOf('validate_api_release_boundary_from_env() {'),
  );
  assert.ok(
    apiValidator.lastIndexOf('/api/healthz/ready')
      > apiValidator.indexOf('await validateCandidateReleaseReadiness'),
  );
  assert.match(apiValidator, /systemctl is-enabled --quiet/u);

  const candidateInitialCheck = production.indexOf("'Candidate Worker private ConfigIdentity'");
  const candidateFence = production.lastIndexOf(
    'begin_app_deploy_transaction',
    candidateInitialCheck,
  );
  const candidateFinalCheck = production.indexOf(
    "'Candidate App final Worker ConfigIdentity'",
    candidateFence,
  );
  const candidateMarker = production.indexOf(
    'commit_app_active_colors "$api_idle" "$worker_idle" "$api_active"',
    candidateFinalCheck,
  );
  assert.ok(candidateInitialCheck > -1);
  assert.ok(candidateFence > -1);
  assert.ok(candidateInitialCheck > candidateFence);
  assert.ok(candidateFinalCheck > candidateInitialCheck);
  assert.ok(candidateMarker > candidateFinalCheck);

  const appEntryStart = production.indexOf('deploy_app() {');
  const appFenceEntry = production.indexOf('begin_app_deploy_transaction', appEntryStart);
  const appArtifactPreparation = production.indexOf('artifact_digest=', appEntryStart);
  const appRollbackArm = production.indexOf(
    'arm_deploy_rollback cleanup_app_failure',
    appEntryStart,
  );
  assert.ok(appFenceEntry > appEntryStart);
  assert.ok(appArtifactPreparation > appFenceEntry);
  assert.ok(appRollbackArm > appArtifactPreparation);
  const diskRollbackStart = production.indexOf('rollback_app_release() {');
  const diskRollbackEnd = production.indexOf('cleanup_app_failure() {', diskRollbackStart);
  const diskRollback = production.slice(diskRollbackStart, diskRollbackEnd);
  assert.doesNotMatch(
    diskRollback,
    /systemctl (?:restart|enable|disable)|nginx -t|commit_app_active_colors/u,
  );

  const rollbackHelperStart = production.indexOf('commit_rollback_worker_authority() {');
  const rollbackHelperEnd = production.indexOf('restore_candidate_worker_authority() {');
  const rollbackHelper = production.slice(rollbackHelperStart, rollbackHelperEnd);
  assert.ok(rollbackHelperStart > -1);
  assert.ok(rollbackHelperEnd > rollbackHelperStart);
  assert.match(
    rollbackHelper,
    /systemctl disable --now "agent-saas-runtime-worker@\$candidate_color"[\s\S]*\|\| disable_status=\$\?/u,
  );
  assert.match(
    rollbackHelper,
    /\[ "\$disable_status" -ne 0 \] \|\| \[ "\$candidate_stopped_ref" != true \]/u,
  );
  const rollbackFinalCheck = rollbackHelper.indexOf("'Rollback Worker final ConfigIdentity'");
  const rollbackMarker = rollbackHelper.indexOf(
    'commit_worker_active_color "$active_color"',
    rollbackFinalCheck,
  );
  assert.ok(rollbackFinalCheck > -1);
  assert.ok(rollbackMarker > rollbackFinalCheck);

  const rollbackStopCandidate = rollbackHelper.indexOf(
    'systemctl disable --now "agent-saas-runtime-worker@$candidate_color"',
  );
  const rollbackStartOld = rollbackHelper.indexOf(
    'systemctl restart "agent-saas-runtime-worker@$active_color"',
  );
  const rollbackPreparedCheck = rollbackHelper.indexOf(
    "'Rollback Worker prepared ConfigIdentity'",
  );
  const rollbackFence = rollbackHelper.indexOf('acquire_config_governance_fence');
  assert.ok(rollbackFence > -1);
  assert.ok(rollbackStartOld > rollbackFence);
  assert.ok(rollbackPreparedCheck > rollbackStartOld);
  assert.ok(rollbackStopCandidate > rollbackPreparedCheck);
  assert.ok(rollbackFinalCheck > rollbackStopCandidate);
  const cleanupStart = production.indexOf('cleanup_app_failure() {');
  const nestedCleanupStart = production.indexOf('  cleanup_app_failure() {', appEntryStart);
  const rollbackFenceGate = production.indexOf(
    'if [ -z "$CONFIG_GOVERNANCE_FENCE" ]',
    nestedCleanupStart,
  );
  const rollbackDiskPreparation = production.indexOf(
    'rollback_app_release || transaction_rollback_status=$?',
    nestedCleanupStart,
  );
  const oldApiReady = production.indexOf(
    "'Rollback old API restored ConfigIdentity'",
    nestedCleanupStart,
  );
  const rollbackHelperCall = production.indexOf(
    'if commit_rollback_worker_authority "$worker_active" "$worker_idle"',
    nestedCleanupStart,
  );
  const rollbackApiCommitCall = production.indexOf(
    '&& commit_rollback_api_authority "$api_active" "$api_idle"',
    rollbackHelperCall,
  );
  assert.ok(rollbackFenceGate > nestedCleanupStart);
  assert.ok(rollbackDiskPreparation > rollbackFenceGate);
  assert.ok(oldApiReady > rollbackDiskPreparation);
  assert.ok(rollbackHelperCall > oldApiReady);
  assert.ok(rollbackApiCommitCall > rollbackHelperCall);
  const rollbackCleanup = production.indexOf(
    '"/run/agent-saas-runtime-worker-$worker_idle.config-identity.json"',
    rollbackHelperCall,
  );
  assert.ok(rollbackHelperCall > cleanupStart);
  assert.ok(rollbackCleanup > rollbackHelperCall);
  const workerRecoveryStart = production.indexOf('restore_candidate_worker_authority() {');
  const workerRecoveryEnd = production.indexOf('deploy_acs() {', workerRecoveryStart);
  const workerRecovery = production.slice(workerRecoveryStart, workerRecoveryEnd);
  const workerRecoveryFence = workerRecovery.indexOf(
    'acquire_config_governance_fence',
  );
  const stopOldWorker = workerRecovery.indexOf(
    'revoke_systemd_authority "agent-saas-runtime-worker@$active_color"',
  );
  const startCandidateWorker = workerRecovery.indexOf(
    'systemctl restart "agent-saas-runtime-worker@$candidate_color"',
  );
  assert.ok(workerRecoveryFence > -1);
  assert.ok(startCandidateWorker > workerRecoveryFence);
  assert.ok(stopOldWorker > startCandidateWorker);
  assert.match(
    workerRecovery,
    /systemctl is-active --quiet "agent-saas-runtime-worker@\$candidate_color"[\s\S]*! systemctl is-active --quiet "agent-saas-runtime-worker@\$active_color"[\s\S]*<"\$marker"/u,
  );
  assert.match(production, /restore_candidate_app_authority \\\n\s*"\$api_active" "\$api_idle"/u);
  assert.match(production, /validate_api_release_boundary_from_env/u);
  assert.match(production, /Rollback old API final ConfigIdentity/u);
  assert.match(production, /rollback_target=candidate/u);
  assert.match(production, /\[ "\$rollback_target" = old \]/u);
  const initialApiCleanup = production.indexOf(
    'rm -f "/run/agent-saas-server-$api_idle.pid"',
  );
  const initialApiSnapshotCleanup = production.indexOf(
    '"/run/agent-saas-server-$api_idle.config-identity.json"',
    initialApiCleanup,
  );
  const initialApiStart = production.indexOf(
    'systemctl enable --now "agent-saas-server@$api_idle"',
    initialApiCleanup,
  );
  assert.ok(initialApiCleanup > -1);
  assert.ok(initialApiSnapshotCleanup > initialApiCleanup);
  assert.ok(initialApiStart > initialApiSnapshotCleanup);

  const apiCommitStart = production.indexOf('commit_rollback_api_authority() {');
  const apiCommitEnd = production.indexOf('restore_candidate_api_authority() {');
  const apiCommit = production.slice(apiCommitStart, apiCommitEnd);
  const apiPrecommitCheck = apiCommit.indexOf("'Rollback old API pre-commit ConfigIdentity'");
  const stopCandidateApi = apiCommit.indexOf(
    'systemctl disable --now "agent-saas-server@$candidate_color"',
  );
  const restoreOldNginx = apiCommit.indexOf('cp -a "$old_nginx_backup" "$upstream"');
  const commitOldApiMarker = apiCommit.indexOf('commit_api_active_color "$active_color"');
  const validateOldRouting = apiCommit.indexOf(
    'validate_api_routing_boundary "$active_color" "$old_release_id"',
  );
  assert.ok(apiPrecommitCheck > -1);
  assert.ok(restoreOldNginx > apiPrecommitCheck);
  assert.ok(validateOldRouting > restoreOldNginx);
  assert.ok(stopCandidateApi > validateOldRouting);
  assert.ok(commitOldApiMarker > stopCandidateApi);
  assert.match(
    apiCommit,
    /\[ "\$disable_status" -ne 0 \] \|\| \[ "\$candidate_stopped_ref" != true \]/u,
  );
  assert.match(apiCommit, /if \[ "\$nginx_changed" = true \]; then/u);
  assert.match(
    apiCommit,
    /systemctl is-enabled --quiet "agent-saas-server@\$candidate_color"/u,
  );

  const apiRecoveryStart = apiCommitEnd;
  const apiRecoveryEnd = production.indexOf('commit_worker_active_color() {', apiRecoveryStart);
  const apiRecovery = production.slice(apiRecoveryStart, apiRecoveryEnd);
  const recoveryApiSnapshotCleanup = apiRecovery.indexOf(
    'agent-saas-server-$candidate_color.config-identity.json',
  );
  const recoveryApiStart = apiRecovery.indexOf(
    'systemctl restart "agent-saas-server@$candidate_color"',
  );
  const restoreCandidateNginx = apiRecovery.indexOf(
    'cp -a "$candidate_nginx_backup" "$upstream"',
  );
  assert.ok(recoveryApiSnapshotCleanup > -1);
  assert.ok(recoveryApiStart > recoveryApiSnapshotCleanup);
  const stopOldApi = apiRecovery.indexOf(
    'revoke_systemd_authority "agent-saas-server@$active_color"',
  );
  const recoveryFinalCheck = apiRecovery.indexOf(
    "'Rollback candidate API final ConfigIdentity'",
  );
  assert.ok(stopOldApi > recoveryApiStart);
  assert.ok(restoreCandidateNginx > stopOldApi);
  assert.ok(recoveryFinalCheck > restoreCandidateNginx);
  assert.match(apiRecovery, /restore_old_api_authority/u);
  assert.match(
    apiRecovery,
    /systemctl is-active --quiet "agent-saas-server@\$candidate_color"[\s\S]*! systemctl.is-active/u,
  );
  assert.match(production, /nginx-candidate-upstream\.conf/u);
  assert.match(apiRecovery, /commit_api_active_color "\$candidate_color"/u);
  assert.match(workerRecovery, /commit_worker_active_color "\$candidate_color"/u);
  assert.match(production, /DEPLOY_APP_ROLLBACK_API_CANDIDATE_ADMITTED=true/u);
  assert.match(production, /DEPLOY_APP_ROLLBACK_WORKER_CANDIDATE_ADMITTED=true/u);
  assert.match(production, /validate_app_release_envs_match "\$old_api_env" "\$old_worker_env"/u);
  const appRecoveryStart = production.indexOf(
    'validate_candidate_api_routing_preparation() {',
  );
  const appRecoveryEnd = production.indexOf('deploy_acs() {', appRecoveryStart);
  const appRecovery = production.slice(appRecoveryStart, appRecoveryEnd);
  const restoreAppStart = appRecovery.indexOf('restore_candidate_app_authority() {');
  const appRecoveryFence = appRecovery.indexOf(
    'acquire_config_governance_fence',
    restoreAppStart,
  );
  const prepareApi = appRecovery.indexOf(
    '"$nginx_changed" "$old_api_env" false true',
    restoreAppStart,
  );
  const prepareWorker = appRecovery.indexOf(
    '"$worker_env" false true true',
    restoreAppStart,
  );
  const finalAppApi = appRecovery.indexOf(
    "'Rollback candidate App prepared API ConfigIdentity'",
    restoreAppStart,
  );
  const finalAppWorker = appRecovery.indexOf(
    "'Rollback candidate App prepared Worker ConfigIdentity'",
    restoreAppStart,
  );
  const preparedRoute = appRecovery.indexOf(
    'validate_candidate_api_routing_preparation',
    finalAppWorker,
  );
  const unifiedCommitCall = appRecovery.indexOf(
    'commit_candidate_app_authority "$api_active" "$api_candidate"',
    preparedRoute,
  );
  assert.ok(appRecoveryFence > restoreAppStart);
  assert.ok(prepareApi > appRecoveryFence);
  assert.ok(prepareWorker > prepareApi);
  assert.ok(finalAppApi > prepareWorker);
  assert.ok(finalAppWorker > finalAppApi);
  assert.ok(preparedRoute > finalAppWorker);
  assert.ok(unifiedCommitCall > preparedRoute);

  const commitStart = appRecovery.indexOf('commit_candidate_app_authority() {');
  const commitEnd = appRecovery.indexOf(
    'restore_candidate_app_authority() {',
    commitStart,
  );
  const appCommit = appRecovery.slice(commitStart, commitEnd);
  const commitApiReady = appCommit.indexOf('Rollback candidate App commit API ConfigIdentity');
  const commitWorkerReady = appCommit.indexOf(
    'Rollback candidate App commit Worker ConfigIdentity',
  );
  const commitRoutePrepared = appCommit.indexOf(
    'validate_candidate_api_routing_preparation',
  );
  const switchCandidateNginx = appCommit.indexOf(
    'cp -a "$candidate_nginx_backup" "$upstream"',
  );
  const stopOldAppWorker = appCommit.indexOf(
    'revoke_systemd_authority "agent-saas-runtime-worker@$worker_active"',
  );
  const stopOldAppApi = appCommit.indexOf(
    'revoke_systemd_authority "agent-saas-server@$api_active"',
  );
  const commitAppMarkers = appCommit.indexOf(
    'commit_app_active_colors "$api_candidate" "$worker_candidate" "$api_active"',
  );
  assert.ok(commitApiReady > -1);
  assert.ok(commitWorkerReady > commitApiReady);
  assert.ok(commitRoutePrepared > commitWorkerReady);
  assert.ok(switchCandidateNginx > commitRoutePrepared);
  assert.ok(stopOldAppWorker > switchCandidateNginx);
  assert.ok(stopOldAppApi > stopOldAppWorker);
  assert.ok(commitAppMarkers > stopOldAppApi);
  assert.match(appRecovery, /restore_old_api_authority/u);
  assert.match(appRecovery, /restore_old_worker_authority/u);
  assert.match(appRecovery, /restore_candidate_app_disk/u);
  const deployAppStart = production.indexOf('deploy_app() {');
  const routedReady = production.indexOf(
    "curl -kfsS -H 'Host: api.agent.kaiyan.net' https://127.0.0.1/api/healthz/ready",
    deployAppStart,
  );
  const forwardApiFinalCheck = production.indexOf(
    "'Candidate API final ConfigIdentity'",
    routedReady,
  );
  const forwardAppApiCheck = production.indexOf(
    "'Candidate App final API ConfigIdentity'",
    forwardApiFinalCheck,
  );
  const forwardAppWorkerCheck = production.indexOf(
    "'Candidate App final Worker ConfigIdentity'",
    forwardAppApiCheck,
  );
  const forwardAppMarker = production.indexOf(
    'commit_app_active_colors "$api_idle" "$worker_idle" "$api_active"',
    forwardAppWorkerCheck,
  );
  assert.ok(deployAppStart > -1);
  assert.ok(routedReady > deployAppStart);
  assert.ok(forwardApiFinalCheck > routedReady);
  assert.ok(forwardAppApiCheck > forwardApiFinalCheck);
  assert.ok(forwardAppWorkerCheck > forwardAppApiCheck);
  assert.ok(forwardAppMarker > forwardAppWorkerCheck);
  // 交接语义：authority 提交后先把 committed 点前移，再把旧 Worker/API 交给后台 drain，
  // 不等待、不 --now 强停；候选侧的最终校验在交接之后继续执行。
  const committedBeforeHandoff = production.indexOf(
    'DEPLOY_APP_ROLLBACK_COMMITTED=true',
    forwardAppMarker,
  );
  const forwardHandoffWorker = production.indexOf(
    'hand_off_retired_authority "agent-saas-runtime-worker@$worker_active"',
    committedBeforeHandoff,
  );
  const forwardHandoffApi = production.indexOf(
    'hand_off_retired_authority "agent-saas-server@$api_active"',
    forwardHandoffWorker,
  );
  const committedApiFinalCheck = production.indexOf(
    "'Committed candidate App final API ConfigIdentity'",
    forwardHandoffApi,
  );
  const committedWorkerFinalCheck = production.indexOf(
    "'Committed candidate App final Worker ConfigIdentity'",
    committedApiFinalCheck,
  );
  const candidateCommitFailure = production.slice(
    production.indexOf("echo 'Candidate App lost authority before marker commit'"),
    committedBeforeHandoff,
  );
  assert.doesNotMatch(candidateCommitFailure, /release_config_governance_fence/u);
  assert.ok(committedBeforeHandoff > forwardAppMarker);
  assert.ok(forwardHandoffWorker > committedBeforeHandoff);
  assert.ok(forwardHandoffApi > forwardHandoffWorker);
  assert.ok(committedApiFinalCheck > forwardHandoffApi);
  assert.ok(committedWorkerFinalCheck > committedApiFinalCheck);
  const deployAppBody = production.slice(deployAppStart, production.indexOf('case "$PHASE" in', deployAppStart));
  assert.doesNotMatch(deployAppBody, /retire_systemd_authority|systemctl disable --now "agent-saas-(?:server|runtime-worker)@\$(?:api|worker)_active"/u);
  const committedRouteCheck = production.indexOf(
    'validate_api_routing_boundary "$api_idle" "$release_id"',
    committedWorkerFinalCheck,
  );
  assert.ok(committedRouteCheck > committedWorkerFinalCheck);
  assert.match(production, /\[ "\$api_candidate_admitted" = true \]/u);
  const appMarkerCommit = production.slice(
    production.indexOf('commit_app_active_colors() {'),
    production.indexOf('rollback_app_release() {'),
  );
  assert.ok(appMarkerCommit.length > 0);
  const apiAuthorityLink = appMarkerCommit.indexOf('ln -s "$authority_link/api"');
  const workerAuthorityLink = appMarkerCommit.indexOf('ln -s "$authority_link/worker"');
  const finalAuthoritySwap = appMarkerCommit.lastIndexOf(
    'mv -fT "$link_candidate" "$authority_link"',
  );
  assert.ok(apiAuthorityLink > 0);
  assert.ok(workerAuthorityLink > apiAuthorityLink);
  assert.ok(finalAuthoritySwap > workerAuthorityLink);
  assert.doesNotMatch(appMarkerCommit, /commit_(api|worker)_active_color/u);
  assert.match(production, /\[ "\$worker_candidate_admitted" = true \]/u);
  assert.match(healthRoute, /摘要本身只走平台管理员 API \/ 私有运行态快照，不进匿名响应/u);
  assert.doesNotMatch(
    healthRoute.slice(
      healthRoute.indexOf("router.get('/healthz/ready'"),
      healthRoute.indexOf("router.get('/healthz/drain'"),
    ),
    /configIdentity\s*[},]/u,
  );
});
