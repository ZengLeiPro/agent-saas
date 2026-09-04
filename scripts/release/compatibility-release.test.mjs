import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createComponentArtifactIndex } from './create-component-artifact-index.mjs';
import { sealCompatibilityRelease } from './seal-compatibility-release.mjs';
import {
  createRuntimeDependencyIdentity,
  loadRuntimeDependencyContract,
} from './runtime-dependency.mjs';
import { buildCompatibilityAppEnvironment } from './write-compatibility-app-env.mjs';
import { buildCompatibilityAcsIdentity } from './write-compatibility-acs-identity.mjs';
import {
  buildLiveProductionIdentity,
  topologyFromLive,
} from './write-live-production-identity.mjs';

const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const RELEASE_ID = 'rc-20260828-33185461811';

async function writeRecoveryRelease(directory, label) {
  await mkdir(directory, { recursive: true });
  for (const [path, content] of [
    ['manifest.webmanifest', `{"name":"${label}"}`],
    [
      'release-identity.json',
      JSON.stringify({
        schemaVersion: 1,
        environment: 'production',
        releaseId: label,
        releaseSha: label,
        webDigest: `sha256:${label}`,
      }),
    ],
    ['index.html', `<html>${label}</html>`],
    ['sw.js', label],
  ])
    await writeFile(join(directory, path), content);
}

async function createRecoveryArchive(root, label) {
  const source = join(root, `${label}-source`);
  const archive = join(root, `${label}.tgz`);
  await writeRecoveryRelease(source, label);
  const tar = spawnSync('tar', ['-C', source, '-czf', archive, '.'], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  return archive;
}

async function createRecoveryArchiveWithFiles(root, label, files) {
  const source = join(root, `${label}-source`);
  const archive = join(root, `${label}.tgz`);
  await writeRecoveryRelease(source, label);
  for (const [relativePath, content] of Object.entries(files)) {
    await mkdir(join(source, relativePath, '..'), { recursive: true });
    await writeFile(join(source, relativePath), content);
  }
  const tar = spawnSync('tar', ['-C', source, '-czf', archive, '.'], { encoding: 'utf8' });
  assert.equal(tar.status, 0, tar.stderr);
  return archive;
}

test('creates component-scoped immutable artifact indexes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'compat-index-'));
  const artifactPath = join(root, 'server-bundle.tgz');
  await writeFile(artifactPath, 'server');
  const index = await createComponentArtifactIndex({
    sourceSha: SHA,
    artifactName: 'serverBundle',
    artifactPath,
  });
  assert.equal(index.schemaVersion, 2);
  assert.equal(index.sourceSha, SHA);
  assert.equal(index.artifacts.serverBundle.path, 'server-bundle.tgz');
  assert.match(index.aggregateDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(index.acsImage, null);
  assert.equal(index.runtimeDependencies, null);
});

test('component indexes reject malformed digest-suffixed ACS image references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'compat-acs-index-'));
  const artifactPath = join(root, 'acs-orchestrator.tgz');
  await writeFile(artifactPath, 'acs');
  await assert.rejects(
    createComponentArtifactIndex({
      sourceSha: SHA,
      artifactName: 'acsOrchestrator',
      artifactPath,
      imageReference: `:@${DIGEST}`,
    }),
    /ACS image reference must use a valid immutable repository digest/u,
  );
});

test('component indexes bind the standalone runtime identity to the same source SHA', async () => {
  const root = await mkdtemp(join(tmpdir(), 'compat-runtime-index-'));
  const artifactPath = join(root, 'server-bundle.tgz');
  const runtimePath = join(root, 'runtime-dependencies.json');
  await writeFile(artifactPath, 'server');
  await writeFile(
    runtimePath,
    `${JSON.stringify(createRuntimeDependencyIdentity(await loadRuntimeDependencyContract(), SHA))}\n`,
  );
  const index = await createComponentArtifactIndex({
    sourceSha: SHA,
    artifactName: 'serverBundle',
    artifactPath,
    runtimeDependencyPath: runtimePath,
  });
  assert.equal(index.schemaVersion, 2);
  assert.equal(index.runtimeDependencies.sourceSha, SHA);
  assert.equal(index.runtimeDependencies.path, 'runtime-dependencies.json');
  assert.equal(
    index.runtimeDependencies.identityDigest,
    createRuntimeDependencyIdentity(await loadRuntimeDependencyContract(), SHA).identityDigest,
  );
  assert.match(index.runtimeDependencies.dependencyDigest, /^sha256:[a-f0-9]{64}$/u);
});

test('seals compatibility releases against both archive and installed bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'compat-seal-'));
  await mkdir(join(root, '.release'));
  await mkdir(join(root, 'server'));
  await writeFile(join(root, '.release', 'server-bundle.tgz'), 'archive');
  await writeFile(join(root, 'server', 'index.js'), 'server');
  const result = await sealCompatibilityRelease({
    rootPath: root,
    component: 'server',
    releaseId: RELEASE_ID,
    sourceSha: SHA,
  });
  assert.equal(result.manifest.releaseSha, SHA);
  assert.equal(result.installed.component, 'server');
  assert.equal(result.installed.artifactDigest, result.manifest.components.api.artifactDigest);
  assert.ok(await readFile(join(root, '.release', 'installed-release-server.json'), 'utf8'));
});

test('builds compatibility runtime identities without carrying stale App metadata', () => {
  const current = {
    components: {
      web: { artifactDigest: DIGEST },
      acs: { orchestratorArtifactDigest: DIGEST, sandboxImageDigest: DIGEST },
    },
  };
  const environment = buildCompatibilityAppEnvironment({
    identity: current,
    releaseId: RELEASE_ID,
    sourceSha: SHA,
    serverDigest: DIGEST,
  });
  assert.equal(environment.AGENT_SAAS_RELEASE_SHA, SHA);
  assert.equal(environment.AGENT_SAAS_WEB_DIGEST, DIGEST);

  const acs = buildCompatibilityAcsIdentity({
    releaseId: RELEASE_ID,
    sourceSha: SHA,
    orchestratorArtifactDigest: DIGEST,
    sandboxImageDigest: DIGEST,
    namespace: 'agent-saas-coding',
    configFingerprint: DIGEST,
  });
  assert.equal(acs.releaseIdentityAttested, undefined);
  assert.equal(acs.environment, 'production');
});

test('rebuilds the trusted identity from the observed live component matrix', () => {
  const components = {
    web: { gitSha: SHA, artifactDigest: DIGEST },
    api: { gitSha: SHA, artifactDigest: DIGEST },
    runtimeWorker: { gitSha: SHA, artifactDigest: DIGEST },
    acs: {
      gitSha: SHA,
      orchestratorArtifactDigest: DIGEST,
      sandboxImageDigest: DIGEST,
    },
  };
  const live = {
    schemaVersion: 1,
    environment: 'production',
    observedAt: '2026-08-28T16:00:00.000Z',
    components,
    topology: {
      api: { color: 'blue', unit: 'agent-saas-server@blue.service' },
      runtimeWorker: { color: 'blue', unit: 'agent-saas-runtime-worker@blue.service' },
    },
  };
  const topology = topologyFromLive(live, {
    readFile: () => 'blue',
    realpath: () => `/opt/agent-saas-app/releases/${DIGEST.slice(7)}`,
  });
  const identity = buildLiveProductionIdentity({ live, topology });
  assert.equal(identity.gitSha, SHA);
  assert.equal(identity.topology.api.activeColor, 'blue');
  assert.equal(identity.components.api.deployedAt, live.observedAt);
  assert.match(identity.configFingerprint, /^sha256:[a-f0-9]{64}$/u);
});

test('legacy deploy entrypoints persist immutable baselines and refresh trusted identity', async () => {
  const [
    appWorkflow,
    acsWorkflow,
    promotionWorkflow,
    acsDeploy,
    recoveryRollback,
    releaseDocs,
    ecsDocs,
    zeroDowntimeDocs,
  ] = await Promise.all([
    readFile('.github/workflows/ci.yml', 'utf8'),
    readFile('.github/workflows/acs-sandbox.yml', 'utf8'),
    readFile('.github/workflows/promote-release.yml', 'utf8'),
    readFile('scripts/deploy-acs-orchestrator.sh', 'utf8'),
    readFile('scripts/rollback-recovery-web.sh', 'utf8'),
    readFile('docs/release-workflow-configuration.md', 'utf8'),
    readFile('docs/ecs-direct-deployment.md', 'utf8'),
    readFile('docs/zero-downtime-deployment.md', 'utf8'),
  ]);
  assert.match(appWorkflow, /baselines\/app-/u);
  assert.match(appWorkflow, /web_only_compatibility:/u);
  assert.match(appWorkflow, /Confirm Web-only compatibility scope/u);
  assert.match(appWorkflow, /block_server_compatibility/u);
  assert.match(appWorkflow, /cannot atomically compensate ECS \+ Web across jobs/u);
  assert.match(appWorkflow, /needs\.deploy_plan\.outputs\.ecs_required == 'false'/u);
  assert.doesNotMatch(appWorkflow, /force_ecs/u);
  assert.match(releaseDocs, /App 入口已收窄为显式确认的 Web-only publish/u);
  assert.match(ecsDocs, /Web-only/u);
  assert.match(ecsDocs, /web_only_compatibility=true/u);
  assert.match(ecsDocs, /fail closed/u);
  assert.match(ecsDocs, /Server\/API\/Runtime Worker 变更必须走 Staging RC 与 Production/u);
  assert.match(ecsDocs, /最终现场读回、identity 写入或确认读回任一步失败/u);
  assert.doesNotMatch(ecsDocs, /force_ecs=true|fail-open/u);
  assert.match(zeroDowntimeDocs, /web_only_compatibility=true/u);
  assert.match(zeroDowntimeDocs, /fail closed/u);
  assert.doesNotMatch(zeroDowntimeDocs, /force_ecs=true|fail-open/u);
  assert.match(appWorkflow, /server-release-stage\/server\/runtime-dependencies\.json/u);
  assert.match(appWorkflow, /baselines\/web-/u);
  assert.match(appWorkflow, /github\.event_name == 'workflow_dispatch' && 'production-runtime'/u);
  assert.match(appWorkflow, /Acquire production host lock for the complete Web transaction/u);
  assert.doesNotMatch(appWorkflow, /agent-saas-production-runtime/u);
  assert.match(appWorkflow, /server_artifact_digest/u);
  assert.match(
    appWorkflow,
    /Commit trusted Production identity after all compatibility targets converge/u,
  );
  assert.match(appWorkflow, /runtime worker rollout: required to converge/u);
  assert.match(appWorkflow, /GITHUB_RUN_ID='\$\{GITHUB_RUN_ID\}'/u);
  assert.match(appWorkflow, /GITHUB_RUN_ATTEMPT='\$\{GITHUB_RUN_ATTEMPT\}'/u);
  assert.match(appWorkflow, /missing GITHUB_RUN_ID/u);
  assert.match(appWorkflow, /missing GITHUB_RUN_ATTEMPT/u);
  assert.equal(
    appWorkflow.match(/write-live-production-identity\.mjs' --input '\$remote\/live\.json'/gu)
      ?.length,
    1,
  );
  assert.ok(
    appWorkflow.indexOf(
      'Commit trusted Production identity after all compatibility targets converge',
    ) > appWorkflow.indexOf('Verify deployed Web'),
  );
  const identityCommitStart = appWorkflow.indexOf(
    '      - name: Commit trusted Production identity after all compatibility targets converge',
  );
  const rollbackStart = appWorkflow.indexOf(
    '      - name: Restore previous recovery Web on failure',
  );
  const finalFailureStart = appWorkflow.indexOf(
    '      - name: Fail compatibility transaction after compensated identity error',
  );
  const identityCommit = appWorkflow.slice(identityCommitStart, rollbackStart);
  const rollback = appWorkflow.slice(rollbackStart, finalFailureStart);
  assert.match(identityCommit, /id: commit_trusted_identity/u);
  assert.match(identityCommit, /continue-on-error: true/u);
  assert.match(identityCommit, /grep -Fx 'state=activated'/u);
  assert.doesNotMatch(identityCommit, /state=\(rolled_back\|not_started\)/u);
  assert.match(identityCommit, /runtime-identity\.before\.json/u);
  assert.match(identityCommit, /--slurpfile before/u);
  assert.match(identityCommit, /\.components\|keep.*before\[0\]\.components\|keep/u);
  assert.match(identityCommit, /--slurpfile live/u);
  assert.match(identityCommit, /\.components\|matrix.*live\[0\]\.components\|matrix/u);

  for (const failurePoint of [
    'read-live-production-components.mjs',
    'write-live-production-identity.mjs',
    'read-production-state.mjs',
  ]) {
    assert.ok(identityCommit.includes(failurePoint));
    assert.ok(
      rollbackStart > identityCommitStart,
      `${failurePoint} failure must reach later rollback`,
    );
    assert.match(
      rollback,
      /if: failure\(\) \|\| cancelled\(\) \|\| steps\.commit_trusted_identity\.outcome == 'failure'/u,
    );
  }
  assert.match(
    appWorkflow,
    /WEB_TRANSACTION_PREFIX: _transactions\/\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u,
  );
  assert.match(appWorkflow, /web-entry-snapshot-complete/u);
  assert.match(appWorkflow, /\$WEB_TRANSACTION_PREFIX\/before\/objects\/\$key/u);
  assert.doesNotMatch(appWorkflow, /_releases\/\$GITHUB_SHA\/previous\/\$f/u);
  assert.match(appWorkflow, /recovery-web-target\.before/u);
  const recoverySnapshotStart = appWorkflow.indexOf(
    '      - name: Snapshot trusted Production identity before Web transaction',
  );
  const webEntrySnapshotStart = appWorkflow.indexOf(
    '      - name: Snapshot all mutable Web keys before transaction',
  );
  const recoverySnapshot = appWorkflow.slice(recoverySnapshotStart, webEntrySnapshotStart);
  assert.match(
    recoverySnapshot,
    /for f in manifest\.webmanifest release-identity\.json index\.html sw\.js/u,
  );
  assert.match(recoverySnapshot, /jq -e '[^']*schemaVersion[^']*webDigest'/u);
  assert.match(appWorkflow, /RECOVERY_WEB_BEFORE_TARGET=\$recovery_web_before_q/u);
  assert.match(appWorkflow, /RUN_ID='\$\{GITHUB_RUN_ID\}\.\$\{GITHUB_RUN_ATTEMPT\}'/u);
  assert.doesNotMatch(appWorkflow, /recovery-web-activated/u);
  assert.match(recoveryRollback, /RECOVERY_WEB_BEFORE_TARGET/u);
  assert.match(recoveryRollback, /transactions\/\$RUN_ID\.activation/u);
  assert.match(recoveryRollback, /state=rolled_back/u);
  assert.match(rollback, /runtime-identity\.before\.json/u);
  assert.match(rollback, /production-state\.restored\.json/u);
  assert.match(rollback, /web-oss-restored/u);
  assert.match(rollback, /state=\(rolled_back\|not_started\)/u);
  assert.match(rollback, /web-recovery-restored/u);
  assert.match(rollback, /while IFS=\$'\\t' read -r state key/u);
  assert.match(rollback, /before\/objects\/\$key/u);
  assert.match(rollback, /ossutil rm "oss:\/\/\$OSS_BUCKET\/\$key"/u);
  assert.match(rollback, /cmp "\$before" "\$restored"/u);
  assert.match(rollback, /cmp "\$before" "\$recovery"/u);
  assert.match(appWorkflow.slice(finalFailureStart), /exit 1/u);
  assert.match(appWorkflow, /trusted identity remains unchanged until Web converges/u);
  assert.match(
    appWorkflow,
    /components\.api\.artifactDigest==\\\$digest[\s\S]*components\.runtimeWorker\.artifactDigest==\\\$digest/u,
  );
  assert.match(appWorkflow, /pre-deploy rollback state captured/u);
  assert.match(appWorkflow, /rollback-compatibility-app\.sh/u);
  assert.match(appWorkflow, /compatibility-deploy-transaction\.sh/u);
  assert.ok(
    appWorkflow.indexOf('pre-deploy rollback state captured') <
      appWorkflow.indexOf('SYSTEMD_UNITS_DIRTY=1'),
  );
  assert.ok(
    appWorkflow.indexOf('SYSTEMD_UNITS_DIRTY=1') < appWorkflow.indexOf('systemd units refreshed'),
  );
  assert.match(
    appWorkflow,
    /rollback_idle_and_exit\(\) \{[\s\S]*restore_predeploy_systemd_units[\s\S]*restoring the previous runtime source and Web color/u,
  );
  assert.match(appWorkflow, /compatibility-deploy-transaction\.sh[\s\S]*restore-symlinks/u);
  assert.match(appWorkflow, /nginx-agent-saas-nas\.conf 0644 nginx-drop-in-present/u);
  assert.match(
    appWorkflow,
    /snapshot_optional_file "\$API_SITE_CONF" api-site\.conf 0644 api-site-present/u,
  );
  assert.ok(
    appWorkflow.indexOf('SYMLINKS_DIRTY=1') <
      appWorkflow.indexOf('ln -sfn "$RELEASE_DIR" "$COLOR_DIR/$IDLE"'),
  );
  assert.ok(
    appWorkflow.indexOf('PREVIOUS_UPDATED=1') <
      appWorkflow.indexOf('ln -sfn "$PREV_CURRENT" "$PREV_LINK"'),
  );
  assert.ok(
    appWorkflow.indexOf('WORKER_SYMLINK_DIRTY=1') <
      appWorkflow.indexOf('ln -sfn "$RELEASE_DIR" "$WORKER_DIR/$WORKER_IDLE"'),
  );
  assert.match(appWorkflow, /restore-symlinks/u);
  assert.match(
    appWorkflow,
    /TRAFFIC_SWITCHED=1\n\s+if ! systemctl reload nginx; then[\s\S]*recover_previous_nginx[\s\S]*TRAFFIC_SWITCHED=0[\s\S]*rollback_idle_and_exit/u,
  );
  assert.match(
    appWorkflow,
    /post-reload verification FAILED[\s\S]*recover_previous_nginx[\s\S]*TRAFFIC_SWITCHED=0[\s\S]*rollback_idle_and_exit/u,
  );
  assert.doesNotMatch(
    appWorkflow,
    /systemctl disable --now "\$\{WORKER_SERVICE\}@\$\{WORKER_IDLE\}" \|\| true/u,
  );
  assert.doesNotMatch(appWorkflow, /systemctl stop "\$\{SERVICE_NAME\}@\$\{IDLE\}" \|\| true/u);
  assert.ok(
    appWorkflow.indexOf('WEB_IDLE_ENABLEMENT_DIRTY=1') <
      appWorkflow.indexOf('systemctl enable --now "${SERVICE_NAME}@${IDLE}"'),
  );
  assert.match(appWorkflow, /failed to restore idle Server disablement during rollback/u);
  assert.match(appWorkflow, /manual recovery marker already recorded for failure line/u);
  assert.match(
    appWorkflow,
    /restore_predeploy_symlinks[\s\S]*restore exact pre-deploy systemd unit snapshot/u,
  );
  assert.match(
    appWorkflow,
    /TRAFFIC_SWITCHED" -eq 1[\s\S]*ROLLBACK_STATE_COMMITTED" -eq 0[\s\S]*mark_manual_recovery/u,
  );
  assert.ok(
    appWorkflow.indexOf('Production identity atomically rebuilt') <
      appWorkflow.indexOf('rollback state committed and rollback.sh refreshed'),
  );
  assert.ok(
    appWorkflow.indexOf('mv -Tf "$ROLLBACK_STATE_LINK.candidate" "$ROLLBACK_STATE_LINK"') <
      appWorkflow.indexOf('"$DEPLOY_ROOT/rollback.sh.candidate"'),
  );
  assert.ok(
    appWorkflow.indexOf('rollback state committed and rollback.sh refreshed') <
      appWorkflow.indexOf('drain signal SIGUSR2 sent to old color'),
  );
  assert.match(appWorkflow, /github\.event_name == 'workflow_dispatch' && 'production-runtime'/u);
  assert.match(acsWorkflow, /group: production-runtime/u);
  assert.match(promotionWorkflow, /group: production-runtime/u);
  assert.doesNotMatch(
    `${appWorkflow}\n${acsWorkflow}\n${promotionWorkflow}`,
    /group: agent-saas-production-deploy/u,
  );
  assert.match(acsWorkflow, /baselines\/acs-/u);
  assert.match(acsWorkflow, /group: production-runtime/u);
  assert.match(
    appWorkflow,
    /format\('agent-saas-\{0\}-\{1\}', github\.workflow, github\.event\.pull_request\.number \|\| github\.ref\)/u,
  );
  assert.match(
    appWorkflow,
    /cancel-in-progress: \$\{\{ github\.event_name != 'workflow_dispatch' \}\}/u,
  );
  assert.match(acsWorkflow, /ACS_IMAGE_REFERENCE/u);
  assert.match(acsWorkflow, /Stale ACS deploy dispatch/u);
  assert.match(acsWorkflow, /before Production mutation/u);
  assert.match(acsWorkflow, /acs-release-stage\/acs-orchestrator\/runtime-dependencies\.json/u);
  assert.match(acsWorkflow, /manage-acs-systemd-unit\.sh/u);
  assert.match(acsWorkflow, /agent-saas-acs-orchestrator\.service\.template/u);
  assert.match(acsWorkflow, /ACS_IMAGE_REFERENCE/u);
  assert.match(acsWorkflow, /environment: production/u);
  assert.match(appWorkflow, /DEPLOY_LOCK_FILE="\/run\/lock\/agent-saas\/promotion\.lock"/u);
  assert.doesNotMatch(appWorkflow, /agent-saas-deploy\.lock/u);
  assert.ok(
    appWorkflow.indexOf('flock -n 9') < appWorkflow.indexOf('identity_probe="/etc/agent-saas/'),
  );
  assert.match(acsWorkflow, /acs-release-identity\.json/u);
  assert.doesNotMatch(acsWorkflow, /后续 main 推进不影响本次代码与镜像/u);
  const acsDeployStart = acsWorkflow.indexOf(
    '      - name: Deploy orchestrator with drain and smoke',
  );
  const acsDeployEnd = acsWorkflow.indexOf('      - name: Clean sealed ACS Production staging');
  const acsDeployStep = acsWorkflow.slice(acsDeployStart, acsDeployEnd);
  assert.match(acsWorkflow, /PRODUCTION_STAGING_ROOT: \/run\/agent-saas-production-staging/u);
  assert.match(acsWorkflow, /Upload and seal orchestrator release/u);
  assert.match(
    acsWorkflow,
    /bash -s -- verify '\$payload_digest' '\$remote\/payload\.tgz' '\$remote'[\s\S]*seal-root-staged-payload\.sh/u,
  );
  assert.match(
    acsWorkflow,
    /seal_script_digest="\$\(sha256sum scripts\/release\/seal-root-staged-payload\.sh/u,
  );
  assert.match(acsWorkflow, /SEAL_STAGED_PAYLOAD_SCRIPT_SHA256='\$seal_script_digest'/u);
  assert.match(acsDeploy, /seal_payload_fd_path="\/proc\/\$\$\/fd\/\$seal_payload_fd"/u);
  assert.match(acsDeploy, /bash "\$seal_payload_fd_path" extract/u);
  assert.match(
    acsDeploy,
    /runtime_environment_file="\$RUNTIME_PREFLIGHT_ROOT\/acs-orchestrator\.env"/u,
  );
  assert.match(acsDeploy, /cp -a "\$RUNTIME_PREFLIGHT_DIR\/\." "\$candidate\/"/u);
  assert.doesNotMatch(acsDeploy, /tar -xzf "\$RELEASE_TGZ"/u);
  assert.doesNotMatch(acsWorkflow, /:\/tmp\/agent-saas-acs-release\.tgz/u);
  assert.match(acsWorkflow, /Clean sealed ACS Production staging/u);
  assert.match(
    acsWorkflow,
    /if: always\(\) && steps\.necessity\.outputs\.deploy_needed == 'true'/u,
  );
  assert.match(acsWorkflow, /sudo rm -rf -- '\$release_remote'/u);
  assert.doesNotMatch(acsWorkflow, /identity_remote/u);
  assert.match(acsDeployStep, /git fetch --no-tags origin main/u);
  assert.match(acsDeployStep, /latest_main_sha="\$\(git rev-parse origin\/main\)"/u);
  assert.match(acsDeployStep, /if \[ "\$latest_main_sha" != "\$GITHUB_SHA" \]/u);
  assert.ok(acsDeployStep.indexOf('latest_main_sha=') < acsDeployStep.indexOf('bash -s'));
  assert.match(releaseDocs, /实际生产\s+部署 mutation 前都会校验 latest main/u);
  assert.match(acsDeploy, /acs-releases\/\$\{ORCHESTRATOR_ARTIFACT_DIGEST#sha256:\}/u);
  assert.match(acsDeploy, /RELEASE_TGZ="\$\{RELEASE_TGZ:-\/tmp\/agent-saas-acs-release\.tgz\}"/u);
  assert.match(acsDeploy, /\/run\/agent-saas-production-staging\/acs-release-\*/u);
  assert.match(acsDeploy, /^cleanup_release_payload\(\)/mu);
  assert.ok(
    acsDeploy.indexOf('trap cleanup_release_payload EXIT') <
      acsDeploy.indexOf(': "${IMAGE:?missing IMAGE}"'),
  );
  assert.match(acsDeploy, /ln -sfn "\$APP_DIR" "\$CURRENT_LINK"/u);
  assert.match(acsDeploy, /lock=\/run\/lock\/agent-saas\/promotion\.lock/u);
  assert.match(appWorkflow, /\/run\/lock\/agent-saas\/promotion\.lock/u);
  assert.match(acsDeploy, /flock -n 9/u);
  assert.match(
    acsDeploy,
    /if \[ "\$\{CURRENT_LINK_UPDATED:-false\}" = "true" \]; then[\s\S]*ln -sfn "\$PREVIOUS_APP_DIR" "\$CURRENT_LINK"/u,
  );
  assert.match(
    acsDeploy,
    /if \[ "\$\{PRODUCTION_CLEANUP_ARMED:-false\}" != "true" \]; then[\s\S]*return "\$deploy_status"/u,
  );
  assert.match(acsDeploy, /ACS_NODE=\/usr\/bin\/node/u);
  assert.match(acsDeploy, /SYSTEMCTL_BIN=\/usr\/bin\/systemctl/u);
  assert.match(
    acsDeploy,
    /"\$ACS_NODE" "\$RUNTIME_PREFLIGHT_DIR\/acs-orchestrator\/dist\/runtime-dependency\.mjs"[\s\S]*--component=acsOrchestrator --environment-file="\$runtime_environment_file" --production=true/u,
  );
  assert.match(
    acsDeploy,
    /validate_acs_managed_unit "\$unit_source" "\$ACS_NODE" "\$ACS_SERVICE_NAME"/u,
  );
  assert.match(
    acsDeploy,
    /install_acs_managed_unit "\$unit_source" "\$ACS_UNIT_PATH" "\$SYSTEMCTL_BIN"/u,
  );
  assert.match(acsDeploy, /restore_acs_managed_unit/u);
  assert.match(acsDeploy, /assert_no_acs_managed_unit_dropins/u);
  assert.ok(
    acsDeploy.indexOf('--environment-file="$runtime_environment_file" --production=true') <
      acsDeploy.indexOf('install_acs_managed_unit'),
  );
  assert.ok(
    acsDeploy.indexOf('install_acs_managed_unit') <
      acsDeploy.indexOf('PRODUCTION_CLEANUP_ARMED=true'),
  );
  assert.ok(
    acsDeploy.indexOf('install_acs_managed_unit') < acsDeploy.indexOf('cp "$ENV_FILE" "$ENV_BAK"'),
  );
  assert.ok(
    acsDeploy.indexOf('PRODUCTION_CLEANUP_ARMED=true') <
      acsDeploy.indexOf('runtime_identity_probe="/etc/agent-saas/'),
  );
  assert.ok(
    acsDeploy.indexOf('--environment-file="$runtime_environment_file" --production=true') <
      acsDeploy.indexOf('candidate="$APP_DIR.candidate-${GITHUB_RUN_ID}"'),
  );
  assert.ok(
    acsDeploy.indexOf('flock -n 9') <
      acsDeploy.indexOf('PREVIOUS_APP_DIR="$(readlink -f "$CURRENT_LINK")"'),
  );
  assert.doesNotMatch(acsDeploy, /APP_DIR="\$ECS_DEPLOY_ROOT"\n/u);
});

test('holds one production host lock through compatibility Web commit and compensation', async () => {
  const [workflow, lease] = await Promise.all([
    readFile('.github/workflows/ci.yml', 'utf8'),
    readFile('scripts/release/production-lock-lease.sh', 'utf8'),
  ]);
  assert.match(workflow, /PRODUCTION_STAGING_ROOT: \/run\/agent-saas-production-staging/u);
  const acquire = workflow.indexOf(
    '      - name: Acquire production host lock for the complete Web transaction',
  );
  const snapshot = workflow.indexOf(
    '      - name: Snapshot trusted Production identity before Web transaction',
  );
  const upload = workflow.indexOf('      - name: Upload to OSS', snapshot);
  const commit = workflow.indexOf(
    '      - name: Commit trusted Production identity after all compatibility targets converge',
  );
  const compensate = workflow.indexOf('      - name: Restore previous recovery Web on failure');
  const release = workflow.indexOf(
    '      - name: Release and clean up production host lock after commit or compensation',
  );
  const fail = workflow.indexOf(
    '      - name: Fail compatibility transaction after compensated identity error',
  );
  assert.ok(
    acquire > 0 &&
      snapshot > acquire &&
      upload > snapshot &&
      commit > upload &&
      compensate > commit &&
      release > compensate &&
      fail > release,
  );
  assert.match(workflow, /PRODUCTION_LOCK_SCRIPT' assert '\$PRODUCTION_LOCK_TOKEN'/u);
  assert.match(workflow, /PRODUCTION_LOCK_SCRIPT' release '\$PRODUCTION_LOCK_TOKEN'/u);
  assert.match(workflow, /sudo install -m 0500 '\$PRODUCTION_LOCK_UPLOAD'/u);
  const identity = workflow.slice(commit, compensate);
  assert.match(identity, /payload_digest="\$\(sha256sum "\$payload_archive"/u);
  assert.match(identity, /PRODUCTION_STAGING_ROOT\/production-identity-/u);
  assert.doesNotMatch(workflow, /\/run\/agent-saas-release-staging/u);
  assert.match(identity, /sudo install -d -m 0700 '\$remote'/u);
  assert.match(identity, /sudo tee '\$remote\/payload\.tgz'/u);
  assert.match(
    identity,
    /bash -s -- extract '\$payload_digest' '\$remote\/payload\.tgz' '\$remote'[\s\S]*seal-root-staged-payload\.sh/u,
  );
  assert.doesNotMatch(identity, /production-identity-payload\.sha256/u);
  assert.match(identity, /sudo node '\$remote\/read-live-production-components\.mjs'/u);
  assert.match(identity, /sudo rm -rf -- '\$remote'/u);
  assert.doesNotMatch(identity, /sudo rm -rf -- '\$remote'[^\n]*\|\| true/u);
  assert.match(lease, /flock -n 9/u);
  assert.match(lease, /kill -0 "\$pid"/u);
  assert.match(lease, /start-time/u);
  assert.match(lease, /\/proc\/\$pid\/fd\/9/u);
  assert.match(lease, /Production lock lease expired before release/u);
});

test('pins every compatibility production SSH connection to the controlled host fingerprint', async () => {
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
  assert.equal(
    workflow.match(
      /PRODUCTION_SSH_HOST_KEY_SHA256: \$\{\{ vars\.PRODUCTION_SSH_HOST_KEY_SHA256 \}\}/gu,
    )?.length,
    3,
  );
  assert.equal(workflow.match(/ssh-keyscan -T 10 -t ed25519 -H "\$ECS_HOST"/gu)?.length, 3);
  assert.equal(workflow.match(/ssh-keygen -lf "\$scan_path" -E sha256/gu)?.length, 3);
  assert.equal(workflow.match(/cat "\$scan_path" >> ~\/\.ssh\/known_hosts/gu)?.length, 3);
  assert.doesNotMatch(workflow, /ssh-keyscan -H "\$ECS_HOST" >> ~\/\.ssh\/known_hosts/u);
});

test('seals recovery Web bytes with a runner-pinned digest in root-only staging', async () => {
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
  const packageStart = workflow.indexOf('      - name: Package recovery Web release');
  const verifyStart = workflow.indexOf('      - name: Verify recovery Web endpoint', packageStart);
  const recovery = workflow.slice(packageStart, verifyStart);
  assert.match(recovery, /RECOVERY_WEB_ARCHIVE_SHA256=\$\(sha256sum "\$archive"/u);
  assert.match(recovery, /PRODUCTION_STAGING_ROOT\/recovery-web-/u);
  assert.match(recovery, /sudo install -d -m 0700 '\$remote'/u);
  assert.match(recovery, /sudo tee '\$remote\/recovery-web\.tgz'/u);
  assert.match(
    recovery,
    /bash -s -- verify '\$RECOVERY_WEB_ARCHIVE_SHA256'[\s\S]*seal-root-staged-payload\.sh/u,
  );
  assert.match(recovery, /ARCHIVE='\$remote\/recovery-web\.tgz' bash -s/u);
  assert.match(recovery, /trap cleanup EXIT/u);
  assert.doesNotMatch(recovery, /ECS_HOST:\/tmp\/agent-saas-recovery-web/u);
});

test('pins and probes the real OSS client capabilities used by immutable uploads', async () => {
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
  assert.match(workflow, /ossutil-2\.1\.2-linux-amd64\.zip/u);
  assert.match(workflow, /ossutil cp --help[\s\S]*ossutil stat --help/u);
  assert.match(workflow, /grep -Eq -- '[^']*--region/u);
  assert.match(workflow, /put-web-asset-create-only\.mjs --self-check/u);
  assert.doesNotMatch(workflow, /ossutil cp[^\n]*--meta/u);
  assert.match(
    workflow,
    /credentials="\$RUNNER_TEMP\/web-oss-sdk-credentials\.json"[\s\S]*umask 077[\s\S]*accessKeyId[\s\S]*upload-web-assets-immutable\.sh[\s\S]*"\$credentials"/u,
  );
  const helper = await readFile('scripts/release/put-web-asset-create-only.mjs', 'utf8');
  assert.match(helper, /'x-oss-forbid-overwrite': 'true'/u);
  assert.doesNotMatch(helper, /process\.env\.(?:OSS_ACCESS|ALI_OSS)/u);
  assert.doesNotMatch(helper, /process\.argv[^\n]*(?:accessKeyId|accessKeySecret)/u);
});

test('snapshots, restores, and proves every mutable Web key class and metadata', async () => {
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
  const snapshotStart = workflow.indexOf(
    '      - name: Snapshot all mutable Web keys before transaction',
  );
  const uploadStart = workflow.indexOf('      - name: Upload to OSS', snapshotStart);
  const identityStart = workflow.indexOf(
    '      - name: Commit trusted Production identity after all compatibility targets converge',
    uploadStart,
  );
  const restoreStart = workflow.indexOf(
    '      - name: Restore all previous mutable Web keys on failure',
  );
  const proofStart = workflow.indexOf(
    '      - name: Prove previous Web and trusted identity after compensation',
  );
  assert.ok(snapshotStart > 0 && uploadStart > snapshotStart && identityStart > uploadStart);
  const snapshot = workflow.slice(snapshotStart, uploadStart);
  for (const keyClass of [
    'icons kaikai-presets',
    'apple-touch-icon.png favicon-16x16.png favicon-32x32.png favicon.ico',
    'kaikai-avatar.png workbox-*.js',
    'manifest.webmanifest release-identity.json index.html sw.js',
  ]) {
    assert.ok(snapshot.includes(keyClass), keyClass);
  }
  assert.match(snapshot, /state=present[\s\S]*ErrorCode\[=:\s\]\+NoSuchKey[\s\S]*state=missing/u);
  assert.match(snapshot, /before\/objects\/\$key/u);
  assert.match(snapshot, /normalize_oss_metadata[\s\S]*web-before-metadata/u);
  assert.match(snapshot, /test "\$http_code" = 404/u);
  const upload = workflow.slice(uploadStart, identityStart);
  assert.match(upload, /upload-web-assets-immutable\.sh/u);
  assert.doesNotMatch(upload, /ossutil cp assets[\s\S]*-r -f/u);
  assert.match(upload, /oss:\/\/\$OSS_BUCKET\/\$d/u);
  assert.match(upload, /oss:\/\/\$OSS_BUCKET\/\$f/u);
  assert.match(
    upload,
    /manifest\.webmanifest[\s\S]*release-identity\.json[\s\S]*index\.html[\s\S]*sw\.js/u,
  );
  const restore = workflow.slice(restoreStart, proofStart);
  assert.match(restore, /while IFS=\$'\\t' read -r state key/u);
  assert.match(restore, /production-identity-restore\.tgz/u);
  assert.match(restore, /bash -s -- extract '\$payload_digest'/u);
  assert.doesNotMatch(restore, /remote_candidate="\/tmp\/runtime-identity-/u);
  assert.match(restore, /present\)[\s\S]*before\/objects\/\$key/u);
  assert.match(restore, /missing\)[\s\S]*ossutil rm "oss:\/\/\$OSS_BUCKET\/\$key"/u);
  const proof = workflow.slice(proofStart);
  assert.match(proof, /payload_digest="\$\(sha256sum "\$payload_archive"/u);
  assert.match(proof, /PRODUCTION_STAGING_ROOT\/production-rollback-proof-/u);
  assert.match(proof, /sudo install -d -m 0700 '\$remote'/u);
  assert.match(proof, /sudo tee '\$remote\/payload\.tgz'/u);
  assert.match(
    proof,
    /bash -s -- extract '\$payload_digest' '\$remote\/payload\.tgz' '\$remote'[\s\S]*seal-root-staged-payload\.sh/u,
  );
  assert.doesNotMatch(proof, /production-proof-payload\.sha256/u);
  assert.match(proof, /sudo node '\$remote\/read-production-state\.mjs'/u);
  assert.match(proof, /sudo rm -rf -- '\$remote'/u);
  assert.doesNotMatch(proof, /sudo rm -rf -- '\$remote'[^\n]*\|\| true/u);
  assert.match(proof, /Web key introduced by failed transaction remains after compensation/u);
  assert.match(proof, /test "\$http_code" = 404/u);
  assert.match(
    proof,
    /cmp "\$before" "\$restored"[\s\S]*web-before-metadata[\s\S]*cmp "\$before" "\$recovery"/u,
  );
});

for (const [label, failurePoint] of [
  ['final live component readback', 'read-live-production-components.mjs'],
  ['trusted identity write', 'write-live-production-identity.mjs'],
  ['confirmed Production readback', 'read-production-state.mjs'],
]) {
  test(`compensates Web-only compatibility when ${label} fails`, async () => {
    const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
    const commitStart = workflow.indexOf(
      '      - name: Commit trusted Production identity after all compatibility targets converge',
    );
    const rollbackStart = workflow.indexOf(
      '      - name: Restore previous recovery Web on failure',
    );
    const proofStart = workflow.indexOf(
      '      - name: Prove previous Web and trusted identity after compensation',
    );
    const failStart = workflow.indexOf(
      '      - name: Fail compatibility transaction after compensated identity error',
    );
    assert.ok(workflow.slice(commitStart, rollbackStart).includes(failurePoint));
    assert.match(
      workflow.slice(rollbackStart, proofStart),
      /cancelled\(\)[\s\S]*steps\.commit_trusted_identity\.outcome == 'failure'/u,
    );
    assert.match(
      workflow.slice(proofStart, failStart),
      /production-state\.restored\.json[\s\S]*web-oss-restored[\s\S]*web-recovery-restored/u,
    );
    assert.match(workflow.slice(failStart), /exit 1/u);
  });
}

test('rolls back recovery Web when activation mutates current before remote output fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recovery-activation-failure-'));
  const oldRelease = join(root, 'releases', 'old');
  await writeRecoveryRelease(oldRelease, 'old');
  const archive = await createRecoveryArchive(root, 'new');
  await symlink(oldRelease, join(root, 'current'));

  const full = openSync('/dev/full', 'w');
  const activation = spawnSync('bash', ['scripts/deploy-recovery-web.sh'], {
    env: {
      ...process.env,
      RECOVERY_WEB_ROOT: root,
      RECOVERY_WEB_BEFORE_TARGET: oldRelease,
      RELEASE_ID: 'new',
      RUN_ID: '123.1',
      ARCHIVE: archive,
    },
    stdio: ['ignore', full, 'pipe'],
    encoding: 'utf8',
  });
  closeSync(full);
  assert.notEqual(activation.status, 0);
  assert.equal(await readlink(join(root, 'current')), join(root, 'releases', 'new'));
  assert.match(
    await readFile(join(root, 'transactions', '123.1.activation'), 'utf8'),
    /state=activated/u,
  );

  const rollback = spawnSync('bash', ['scripts/rollback-recovery-web.sh'], {
    env: {
      ...process.env,
      RECOVERY_WEB_ROOT: root,
      RECOVERY_WEB_BEFORE_TARGET: oldRelease,
      RUN_ID: '123.1',
    },
    encoding: 'utf8',
  });
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.equal(await readlink(join(root, 'current')), oldRelease);
  assert.match(
    await readFile(join(root, 'transactions', '123.1.activation'), 'utf8'),
    /state=rolled_back/u,
  );
});

test('rejects late recovery deploys after terminal receipts and replays terminal rollback safely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recovery-terminal-replay-'));
  const olderRelease = join(root, 'releases', 'older');
  const oldRelease = join(root, 'releases', 'old');
  await writeRecoveryRelease(olderRelease, 'older');
  await writeRecoveryRelease(oldRelease, 'old');
  await symlink(oldRelease, join(root, 'current'));
  await symlink(olderRelease, join(root, 'previous'));

  const notStartedRollback = spawnSync('bash', ['scripts/rollback-recovery-web.sh'], {
    env: {
      ...process.env,
      RECOVERY_WEB_ROOT: root,
      RECOVERY_WEB_BEFORE_TARGET: oldRelease,
      RUN_ID: 'late.1',
    },
    encoding: 'utf8',
  });
  assert.equal(notStartedRollback.status, 0, notStartedRollback.stderr);
  const lateArchive = await createRecoveryArchive(root, 'late');
  const lateDeploy = spawnSync('bash', ['scripts/deploy-recovery-web.sh'], {
    env: {
      ...process.env,
      RECOVERY_WEB_ROOT: root,
      RECOVERY_WEB_BEFORE_TARGET: oldRelease,
      RELEASE_ID: 'late',
      RUN_ID: 'late.1',
      ARCHIVE: lateArchive,
    },
    encoding: 'utf8',
  });
  assert.notEqual(lateDeploy.status, 0);
  assert.equal(await readlink(join(root, 'current')), oldRelease);
  assert.match(
    await readFile(join(root, 'transactions', 'late.1.activation'), 'utf8'),
    /state=not_started/u,
  );

  const archive = await createRecoveryArchive(root, 'new');
  const deployEnv = {
    ...process.env,
    RECOVERY_WEB_ROOT: root,
    RECOVERY_WEB_BEFORE_TARGET: oldRelease,
    RELEASE_ID: 'new',
    RUN_ID: 'rolled.1',
    ARCHIVE: archive,
  };
  const activation = spawnSync('bash', ['scripts/deploy-recovery-web.sh'], {
    env: deployEnv,
    encoding: 'utf8',
  });
  assert.equal(activation.status, 0, activation.stderr);
  const duplicateActivation = spawnSync('bash', ['scripts/deploy-recovery-web.sh'], {
    env: deployEnv,
    encoding: 'utf8',
  });
  assert.equal(duplicateActivation.status, 0, duplicateActivation.stderr);

  const partialRollback = spawnSync('ln', ['-sfn', oldRelease, join(root, 'current')], {
    encoding: 'utf8',
  });
  assert.equal(partialRollback.status, 0, partialRollback.stderr);

  const rollbackEnv = {
    ...process.env,
    RECOVERY_WEB_ROOT: root,
    RECOVERY_WEB_BEFORE_TARGET: oldRelease,
    RUN_ID: 'rolled.1',
  };
  const rollback = spawnSync('bash', ['scripts/rollback-recovery-web.sh'], {
    env: rollbackEnv,
    encoding: 'utf8',
  });
  assert.equal(rollback.status, 0, rollback.stderr);
  const duplicateRollback = spawnSync('bash', ['scripts/rollback-recovery-web.sh'], {
    env: rollbackEnv,
    encoding: 'utf8',
  });
  assert.equal(duplicateRollback.status, 0, duplicateRollback.stderr);
  assert.equal(await readlink(join(root, 'current')), oldRelease);
  assert.equal(await readlink(join(root, 'previous')), olderRelease);

  const replayDeploy = spawnSync('bash', ['scripts/deploy-recovery-web.sh'], {
    env: deployEnv,
    encoding: 'utf8',
  });
  assert.notEqual(replayDeploy.status, 0);
  assert.equal(await readlink(join(root, 'current')), oldRelease);
  assert.match(
    await readFile(join(root, 'transactions', 'rolled.1.activation'), 'utf8'),
    /state=rolled_back/u,
  );
});

test('rejects recovery activation before mutation when the rollback baseline is incomplete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recovery-bad-baseline-'));
  const badRelease = join(root, 'releases', 'missing');
  await mkdir(badRelease, { recursive: true });
  await writeFile(join(badRelease, 'index.html'), '<html>incomplete</html>');
  await symlink(badRelease, join(root, 'current'));
  const archive = await createRecoveryArchive(root, 'new');
  const activation = spawnSync('bash', ['scripts/deploy-recovery-web.sh'], {
    env: {
      ...process.env,
      RECOVERY_WEB_ROOT: root,
      RECOVERY_WEB_BEFORE_TARGET: badRelease,
      RELEASE_ID: 'new',
      RUN_ID: 'bad.1',
      ARCHIVE: archive,
    },
    encoding: 'utf8',
  });
  assert.notEqual(activation.status, 0);
  assert.equal(await readlink(join(root, 'current')), badRelease);
  await assert.rejects(readFile(join(root, 'transactions', 'bad.1.activation'), 'utf8'));

  const emptyRoot = await mkdtemp(join(tmpdir(), 'recovery-empty-baseline-'));
  const emptyArchive = await createRecoveryArchive(emptyRoot, 'new');
  const emptyActivation = spawnSync('bash', ['scripts/deploy-recovery-web.sh'], {
    env: {
      ...process.env,
      RECOVERY_WEB_ROOT: emptyRoot,
      RECOVERY_WEB_BEFORE_TARGET: join(emptyRoot, 'releases', 'missing'),
      RELEASE_ID: 'new',
      RUN_ID: 'empty.1',
      ARCHIVE: emptyArchive,
    },
    encoding: 'utf8',
  });
  assert.notEqual(emptyActivation.status, 0);
  await assert.rejects(readFile(join(emptyRoot, 'transactions', 'empty.1.activation'), 'utf8'));
});

test('rejects conflicting immutable recovery assets before changing current or previous', async () => {
  for (const relativePath of ['assets/app-deadbeef.js', 'workbox-deadbeef.js']) {
    const root = await mkdtemp(join(tmpdir(), 'recovery-immutable-conflict-'));
    const olderRelease = join(root, 'releases', 'older');
    const oldRelease = join(root, 'releases', 'old');
    await writeRecoveryRelease(olderRelease, 'older');
    await writeRecoveryRelease(oldRelease, 'old');
    await symlink(oldRelease, join(root, 'current'));
    await symlink(olderRelease, join(root, 'previous'));
    const sharedPath = join(root, 'shared-root', relativePath);
    await mkdir(join(sharedPath, '..'), { recursive: true });
    await writeFile(sharedPath, 'existing-byte');
    const archive = await createRecoveryArchiveWithFiles(root, 'new', {
      [relativePath]: 'different-byte',
    });

    const activation = spawnSync('bash', ['scripts/deploy-recovery-web.sh'], {
      env: {
        ...process.env,
        RECOVERY_WEB_ROOT: root,
        RECOVERY_WEB_BEFORE_TARGET: oldRelease,
        RELEASE_ID: 'new',
        RUN_ID: relativePath.startsWith('assets/') ? 'asset.1' : 'workbox.1',
        ARCHIVE: archive,
      },
      encoding: 'utf8',
    });
    assert.notEqual(activation.status, 0, relativePath);
    assert.match(activation.stderr, /immutable recovery Web asset conflicts/u);
    assert.equal(await readlink(join(root, 'current')), oldRelease);
    assert.equal(await readlink(join(root, 'previous')), olderRelease);
    assert.equal(await readFile(sharedPath, 'utf8'), 'existing-byte');
    const receipt = await readFile(
      join(
        root,
        'transactions',
        relativePath.startsWith('assets/') ? 'asset.1.activation' : 'workbox.1.activation',
      ),
      'utf8',
    );
    assert.match(receipt, /state=attempted/u);
    assert.doesNotMatch(receipt, /state=activated/u);
  }
});
