import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createComponentArtifactIndex } from './create-component-artifact-index.mjs';
import { sealCompatibilityRelease } from './seal-compatibility-release.mjs';
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

test('creates component-scoped immutable artifact indexes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'compat-index-'));
  const artifactPath = join(root, 'server-bundle.tgz');
  await writeFile(artifactPath, 'server');
  const index = await createComponentArtifactIndex({
    sourceSha: SHA,
    artifactName: 'serverBundle',
    artifactPath,
  });
  assert.equal(index.sourceSha, SHA);
  assert.equal(index.artifacts.serverBundle.path, 'server-bundle.tgz');
  assert.match(index.aggregateDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(index.acsImage, null);
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
  assert.match(appWorkflow, /baselines\/web-/u);
  assert.match(appWorkflow, /github\.event_name == 'workflow_dispatch' && 'production-runtime'/u);
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
      /if: failure\(\) \|\| steps\.commit_trusted_identity\.outcome == 'failure'/u,
    );
  }
  assert.match(
    appWorkflow,
    /WEB_TRANSACTION_PREFIX: _transactions\/\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u,
  );
  assert.match(appWorkflow, /web-entry-snapshot-complete/u);
  assert.match(appWorkflow, /\$WEB_TRANSACTION_PREFIX\/before\/\$f/u);
  assert.doesNotMatch(appWorkflow, /_releases\/\$GITHUB_SHA\/previous\/\$f/u);
  assert.match(appWorkflow, /recovery-web-target\.before/u);
  const recoverySnapshotStart = appWorkflow.indexOf(
    '      - name: Snapshot trusted Production identity before Web transaction',
  );
  const webEntrySnapshotStart = appWorkflow.indexOf(
    '      - name: Snapshot current Web entry files',
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
  assert.match(
    rollback,
    /for f in manifest\.webmanifest release-identity\.json index\.html sw\.js/u,
  );
  assert.match(
    rollback,
    /cmp "\$RUNNER_TEMP\/web-before\/\$f" "\$RUNNER_TEMP\/web-oss-restored\/\$f"/u,
  );
  assert.match(
    rollback,
    /cmp "\$RUNNER_TEMP\/web-before\/\$f" "\$RUNNER_TEMP\/web-recovery-restored\/\$f"/u,
  );
  assert.match(appWorkflow.slice(finalFailureStart), /exit 1/u);
  assert.match(appWorkflow, /trusted identity remains unchanged until Web converges/u);
  assert.match(
    appWorkflow,
    /components\.api\.artifactDigest==\\\$digest[\s\S]*components\.runtimeWorker\.artifactDigest==\\\$digest/u,
  );
  assert.match(appWorkflow, /github\.event_name == 'workflow_dispatch' && 'production-runtime'/u);
  assert.match(acsWorkflow, /group: production-runtime/u);
  assert.match(promotionWorkflow, /group: production-runtime/u);
  assert.match(acsWorkflow, /baselines\/acs-/u);
  assert.match(acsWorkflow, /group: production-runtime/u);
  assert.match(appWorkflow, /format\('agent-saas-\{0\}', github\.run_id\)/u);
  assert.match(acsWorkflow, /ACS_IMAGE_REFERENCE/u);
  assert.match(acsWorkflow, /Stale ACS deploy dispatch/u);
  assert.match(acsWorkflow, /before Production mutation/u);
  assert.match(acsWorkflow, /acs-release-identity\.json/u);
  assert.doesNotMatch(acsWorkflow, /后续 main 推进不影响本次代码与镜像/u);
  const acsDeployStart = acsWorkflow.indexOf(
    '      - name: Deploy orchestrator with drain and smoke',
  );
  const acsIdentityStart = acsWorkflow.indexOf('      - name: Refresh trusted Production identity');
  const acsDeployStep = acsWorkflow.slice(acsDeployStart, acsIdentityStart);
  assert.match(acsDeployStep, /git fetch --no-tags origin main/u);
  assert.match(acsDeployStep, /latest_main_sha="\$\(git rev-parse origin\/main\)"/u);
  assert.match(acsDeployStep, /if \[ "\$latest_main_sha" != "\$GITHUB_SHA" \]/u);
  assert.ok(acsDeployStep.indexOf('latest_main_sha=') < acsDeployStep.indexOf('bash -s'));
  assert.match(releaseDocs, /实际生产\s+部署 mutation 前都会校验 latest main/u);
  assert.match(acsDeploy, /acs-releases\/\$\{ORCHESTRATOR_ARTIFACT_DIGEST#sha256:\}/u);
  assert.match(acsDeploy, /ln -sfn "\$APP_DIR" "\$CURRENT_LINK"/u);
  assert.doesNotMatch(acsDeploy, /APP_DIR="\$ECS_DEPLOY_ROOT"\n/u);
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
      /steps\.commit_trusted_identity\.outcome == 'failure'/u,
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
