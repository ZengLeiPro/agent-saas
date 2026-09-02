import assert from 'node:assert/strict';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const SCRIPT = resolve('scripts/release/compatibility-deploy-transaction.sh');
const WORKFLOW = resolve('.github/workflows/ci.yml');

async function workflowFragment(startMarker, endMarker) {
  const workflow = await readFile(WORKFLOW, 'utf8');
  const start = workflow.indexOf(`          ${startMarker}`);
  const end = workflow.indexOf(`\n          ${endMarker}`, start);
  assert.notEqual(start, -1, `missing workflow marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing workflow marker: ${endMarker}`);
  return workflow.slice(start, end).replace(/^ {10}/gmu, '');
}

async function installTransactionHelper(releaseDir) {
  const target = join(releaseDir, 'scripts', 'release', 'compatibility-deploy-transaction.sh');
  await mkdir(join(releaseDir, 'scripts', 'release'), { recursive: true });
  await writeFile(target, await readFile(SCRIPT));
  await chmod(target, 0o755);
}

async function fixture({ workerUnitPresent = true, nginxDropInPresent = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'compatibility-transaction-'));
  const deployRoot = join(root, 'deploy');
  const stateDir = join(deployRoot, 'rollback-states', 'rc-test');
  const etcDir = join(root, 'etc');
  const binDir = join(root, 'bin');
  await Promise.all([
    mkdir(stateDir, { recursive: true }),
    mkdir(etcDir, { recursive: true }),
    mkdir(binDir, { recursive: true }),
  ]);

  const serverUnit = join(etcDir, 'agent-saas-server@.service');
  const workerUnit = join(etcDir, 'agent-saas-runtime-worker@.service');
  const nginxDropIn = join(etcDir, 'nginx-agent-saas-nas.conf');
  const systemctlLog = join(root, 'systemctl.log');
  const systemctl = join(binDir, 'systemctl');

  await Promise.all([
    writeFile(join(stateDir, 'server@.service'), 'old server unit\n'),
    writeFile(join(stateDir, 'worker-unit-present'), `${workerUnitPresent}\n`),
    writeFile(join(stateDir, 'nginx-drop-in-present'), `${nginxDropInPresent}\n`),
    writeFile(serverUnit, 'candidate server unit\n'),
    writeFile(workerUnit, 'candidate worker unit\n'),
    writeFile(nginxDropIn, 'candidate nginx drop-in\n'),
    writeFile(
      systemctl,
      '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$SYSTEMCTL_LOG"\nif [ "${SYSTEMCTL_FAIL_RELOAD:-false}" = true ] && [ "$*" = "reload nginx" ]; then exit 1; fi\n',
    ),
  ]);
  if (workerUnitPresent) {
    await writeFile(join(stateDir, 'runtime-worker@.service'), 'old worker unit\n');
  }
  if (nginxDropInPresent) {
    await writeFile(join(stateDir, 'nginx-agent-saas-nas.conf'), 'old nginx drop-in\n');
  }
  await chmod(systemctl, 0o755);

  return {
    root,
    deployRoot,
    stateDir,
    serverUnit,
    workerUnit,
    nginxDropIn,
    systemctl,
    systemctlLog,
    environment: {
      ...process.env,
      DEPLOY_ROOT: deployRoot,
      ROLLBACK_STATE_DIR: stateDir,
      SERVER_UNIT_PATH: serverUnit,
      WORKER_UNIT_PATH: workerUnit,
      NGINX_DROP_IN_PATH: nginxDropIn,
      SYSTEMCTL_BIN: systemctl,
      SYSTEMCTL_LOG: systemctlLog,
    },
  };
}

function run(mode, environment) {
  return spawnSync('bash', [SCRIPT, mode], {
    encoding: 'utf8',
    env: environment,
  });
}

test('candidate readiness failure restores previous units before old topology can restart', async () => {
  const value = await fixture();
  const result = run('restore-units', value.environment);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(value.serverUnit, 'utf8'), 'old server unit\n');
  assert.equal(await readFile(value.workerUnit, 'utf8'), 'old worker unit\n');
  assert.equal(await readFile(value.nginxDropIn, 'utf8'), 'old nginx drop-in\n');
  assert.equal(await readFile(value.systemctlLog, 'utf8'), 'daemon-reload\n');
});

test('first migration removes the candidate Worker unit when the previous deployment had none', async () => {
  const value = await fixture({ workerUnitPresent: false });
  const result = run('restore-units', value.environment);

  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(stat(value.workerUnit), { code: 'ENOENT' });
  assert.equal(await readFile(value.systemctlLog, 'utf8'), 'daemon-reload\n');
});

test('first nginx integration removes the candidate drop-in when the previous deployment had none', async () => {
  const value = await fixture({ nginxDropInPresent: false });
  const result = run('restore-units', value.environment);

  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(stat(value.nginxDropIn), { code: 'ENOENT' });
  assert.equal(await readFile(value.systemctlLog, 'utf8'), 'daemon-reload\n');
});

test('unit restore failure still restores later boundaries, reloads systemd, and returns 70', async () => {
  const value = await fixture();
  const missingParentServerUnit = join(value.root, 'missing', 'agent-saas-server@.service');
  const result = run('restore-units', {
    ...value.environment,
    SERVER_UNIT_PATH: missingParentServerUnit,
  });

  assert.equal(result.status, 70, result.stderr);
  assert.equal(await readFile(value.workerUnit, 'utf8'), 'old worker unit\n');
  assert.equal(await readFile(value.systemctlLog, 'utf8'), 'daemon-reload\n');
  assert.match(result.stderr, /unit restoration completed with one or more failures/u);
});

test('partial symlink replacement failure restores all write-ahead Server and Worker links', async () => {
  const value = await fixture();
  const links = join(value.deployRoot, 'links');
  const targets = join(value.deployRoot, 'targets');
  await Promise.all([mkdir(links), mkdir(targets)]);

  const currentLink = join(links, 'current');
  const previousLink = join(links, 'previous');
  const idleLink = join(links, 'green');
  const workerIdleLink = join(links, 'worker-green');
  const oldCurrent = join(targets, 'old-current');
  const oldPrevious = join(targets, 'old-previous');
  const oldIdle = join(targets, 'old-idle');
  const oldWorkerIdle = join(targets, 'old-worker-idle');
  const candidate = join(targets, 'candidate');
  await Promise.all(
    [oldCurrent, oldPrevious, oldIdle, oldWorkerIdle, candidate].map((path) => mkdir(path)),
  );
  await Promise.all([
    symlink(candidate, currentLink),
    symlink(candidate, idleLink),
    symlink(candidate, workerIdleLink),
  ]);

  const failingLn = join(value.root, 'bin', 'ln');
  await writeFile(
    failingLn,
    '#!/usr/bin/env bash\nif [ "$2" = "$FAIL_TARGET" ]; then rm -f "$3"; exit 1; fi\nexec /bin/ln "$@"\n',
  );
  await chmod(failingLn, 0o755);
  const result = spawnSync(
    'bash',
    [
      '-c',
      'PREVIOUS_UPDATED=1; if ln -sfn "$CANDIDATE" "$PREVIOUS_LINK"; then exit 99; fi; bash "$SCRIPT" restore-symlinks',
    ],
    {
      encoding: 'utf8',
      env: {
        ...value.environment,
        PATH: `${join(value.root, 'bin')}:/usr/bin:/bin`,
        SCRIPT,
        FAIL_TARGET: candidate,
        CANDIDATE: candidate,
        SYMLINKS_DIRTY: '1',
        WORKER_SYMLINK_DIRTY: '1',
        PREV_LINK: currentLink,
        PREV_CURRENT: oldCurrent,
        PREVIOUS_UPDATED: '1',
        PREVIOUS_LINK: previousLink,
        PREV_PREVIOUS: oldPrevious,
        COLOR_IDLE_LINK: idleLink,
        PREV_IDLE_TARGET: oldIdle,
        WORKER_IDLE_LINK: workerIdleLink,
        PREV_WORKER_IDLE_TARGET: oldWorkerIdle,
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readlink(currentLink), oldCurrent);
  assert.equal(await readlink(previousLink), oldPrevious);
  assert.equal(await readlink(idleLink), oldIdle);
  assert.equal(await readlink(workerIdleLink), oldWorkerIdle);
});

test('failed nginx flip-back preserves rollback state and writes manual recovery evidence', async () => {
  const value = await fixture();
  const nginxDir = join(value.root, 'nginx');
  await mkdir(nginxDir);
  const upstream = join(nginxDir, 'upstream.conf');
  const upstreamBak = join(nginxDir, 'upstream.conf.bak');
  const apiSite = join(nginxDir, 'api.conf');
  const apiSiteBak = join(nginxDir, 'api.conf.bak');
  const nginxLog = join(value.root, 'nginx.log');
  const nginx = join(value.root, 'bin', 'nginx');
  const candidateRelease = join(value.deployRoot, 'releases', 'candidate');
  await mkdir(candidateRelease, { recursive: true });
  await Promise.all([
    writeFile(upstream, 'candidate upstream\n'),
    writeFile(upstreamBak, 'old upstream\n'),
    writeFile(apiSite, 'candidate api site\n'),
    writeFile(apiSiteBak, 'old api site\n'),
    writeFile(join(candidateRelease, 'keep-me'), 'candidate remains\n'),
    writeFile(nginx, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$NGINX_LOG"\n'),
  ]);
  await chmod(nginx, 0o755);

  const result = run('recover-nginx-switch', {
    ...value.environment,
    RELEASE_ID: 'rc-test',
    FAILED_STATUS: '1',
    FAILED_LINE: '2297',
    UPSTREAM_CONF: upstream,
    UPSTREAM_BAK: upstreamBak,
    API_SITE_CONF: apiSite,
    API_SITE_BAK: apiSiteBak,
    NGINX_BIN: nginx,
    NGINX_LOG: nginxLog,
    SYSTEMCTL_FAIL_RELOAD: 'true',
  });

  assert.equal(result.status, 70, result.stderr);
  assert.equal(await readFile(upstream, 'utf8'), 'old upstream\n');
  assert.equal(await readFile(apiSite, 'utf8'), 'old api site\n');
  assert.equal(await readFile(nginxLog, 'utf8'), '-t\n');
  assert.equal(await readFile(value.systemctlLog, 'utf8'), 'reload nginx\n');
  assert.equal(await readFile(join(candidateRelease, 'keep-me'), 'utf8'), 'candidate remains\n');
  const markerPath = join(value.stateDir, 'manual-recovery-required');
  assert.match(await readFile(markerPath, 'utf8'), /^trafficSwitched=true$/mu);
  assert.equal((await stat(markerPath)).mode & 0o777, 0o600);
});

test('production workflow symlink wrapper restores write-ahead state after partial replacement', async () => {
  const value = await fixture();
  const releaseDir = join(value.deployRoot, 'releases', 'candidate');
  await installTransactionHelper(releaseDir);
  const links = join(value.deployRoot, 'workflow-links');
  const targets = join(value.deployRoot, 'workflow-targets');
  await Promise.all([mkdir(links), mkdir(targets)]);
  const oldTarget = join(targets, 'old');
  const candidateTarget = join(targets, 'candidate');
  await Promise.all([mkdir(oldTarget), mkdir(candidateTarget)]);
  const appLink = join(links, 'current');
  const idleLink = join(links, 'green');
  await Promise.all([symlink(candidateTarget, appLink), symlink(candidateTarget, idleLink)]);

  const restoreWrapper = await workflowFragment(
    'restore_predeploy_symlinks() {',
    'restore_predeploy_systemd_units() {',
  );
  const harness = join(value.root, 'restore-wrapper.sh');
  await writeFile(
    harness,
    `#!/usr/bin/env bash
set -Eeuo pipefail
log() { :; }
${restoreWrapper}
restore_predeploy_symlinks
printf 'server=%s worker=%s\n' "$SYMLINKS_DIRTY" "$WORKER_SYMLINK_DIRTY"
`,
  );
  await chmod(harness, 0o755);
  const result = spawnSync('bash', [harness], {
    encoding: 'utf8',
    env: {
      ...value.environment,
      RELEASE_DIR: releaseDir,
      APP_LINK: appLink,
      COLOR_DIR: links,
      IDLE: 'green',
      PREV_LINK: join(links, 'previous'),
      PREV_CURRENT: oldTarget,
      PREVIOUS_UPDATED: '0',
      PREV_PREVIOUS: '',
      PREV_IDLE_TARGET: oldTarget,
      WORKER_DIR: links,
      WORKER_IDLE: '',
      PREV_WORKER_IDLE_TARGET: '',
      SYMLINKS_DIRTY: '1',
      WORKER_SYMLINK_DIRTY: '0',
      ROLLBACK_STATE_PRESERVE: '0',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'server=0 worker=0\n');
  assert.equal(await readlink(appLink), oldTarget);
  assert.equal(await readlink(idleLink), oldTarget);
});

test('production workflow nginx wrapper propagates the failure line into manual recovery evidence', async () => {
  const value = await fixture();
  const releaseDir = join(value.deployRoot, 'releases', 'candidate');
  await installTransactionHelper(releaseDir);
  const nginxDir = join(value.root, 'workflow-nginx');
  await mkdir(nginxDir);
  const upstream = join(nginxDir, 'upstream.conf');
  const upstreamBak = join(nginxDir, 'upstream.conf.bak');
  const apiSite = join(nginxDir, 'api.conf');
  const apiSiteBak = join(nginxDir, 'api.conf.bak');
  const nginx = join(value.root, 'bin', 'nginx');
  await Promise.all([
    writeFile(upstream, 'candidate upstream\n'),
    writeFile(upstreamBak, 'old upstream\n'),
    writeFile(apiSite, 'candidate api\n'),
    writeFile(apiSiteBak, 'old api\n'),
    writeFile(nginx, '#!/usr/bin/env bash\nexit 0\n'),
  ]);
  await chmod(nginx, 0o755);
  const recoverWrapper = await workflowFragment('recover_previous_nginx() {', 'on_error() {');
  const harness = join(value.root, 'recover-wrapper.sh');
  await writeFile(
    harness,
    `#!/usr/bin/env bash
set -Eeuo pipefail
${recoverWrapper}
if recover_previous_nginx 4321; then exit 99; else status=$?; fi
printf 'status=%s line=%s\n' "$status" "$FAILURE_LINE"
`,
  );
  await chmod(harness, 0o755);
  const result = spawnSync('bash', [harness], {
    encoding: 'utf8',
    env: {
      ...value.environment,
      RELEASE_DIR: releaseDir,
      RELEASE_ID: 'rc-test',
      UPSTREAM_CONF: upstream,
      UPSTREAM_BAK: upstreamBak,
      API_SITE_CONF: apiSite,
      API_SITE_BAK: apiSiteBak,
      PATH: `${join(value.root, 'bin')}:/usr/bin:/bin`,
      SYSTEMCTL_FAIL_RELOAD: 'true',
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'status=70 line=4321\n');
  assert.match(
    await readFile(join(value.stateDir, 'manual-recovery-required'), 'utf8'),
    /^failedLine=4321$/mu,
  );
});

test('production EXIT trap preserves candidate and rollback snapshot after uncertain switch', async () => {
  const value = await fixture();
  const releaseDir = join(value.deployRoot, 'releases', 'candidate');
  await installTransactionHelper(releaseDir);
  await writeFile(join(releaseDir, 'keep-me'), 'candidate remains\n');
  const releaseTgz = join(value.root, 'candidate.tgz');
  await writeFile(releaseTgz, 'upload remains while traffic is uncertain\n');
  const markWrapper = await workflowFragment(
    'mark_manual_recovery() {',
    'recover_previous_nginx() {',
  );
  const onExit = await workflowFragment('on_exit() {', "trap 'on_error $LINENO' ERR");
  const harness = join(value.root, 'exit-wrapper.sh');
  await writeFile(
    harness,
    `#!/usr/bin/env bash
set -u
log() { :; }
restore_predeploy_systemd_units() { return 0; }
restore_predeploy_symlinks() { return 0; }
${markWrapper}
${onExit}
set +e
(exit 23)
on_exit
`,
  );
  await chmod(harness, 0o755);
  const result = spawnSync('bash', [harness], {
    encoding: 'utf8',
    env: {
      ...value.environment,
      RELEASE_DIR: releaseDir,
      RELEASES_DIR: join(value.deployRoot, 'releases'),
      RELEASE_TGZ: releaseTgz,
      RELEASE_ID: 'rc-test',
      FAILURE_STATUS: '23',
      FAILURE_LINE: '4321',
      TRAFFIC_SWITCHED: '1',
      ROLLBACK_STATE_COMMITTED: '0',
      ROLLBACK_STATE_PRESERVE: '0',
      SYSTEMD_UNITS_DIRTY: '0',
      UNIT_RESTORE_FAILED: '0',
      SYMLINKS_DIRTY: '0',
      WORKER_SYMLINK_DIRTY: '0',
      FAILURE_RECOVERY_ACTIVE: '0',
      FAILURE_RECOVERY_COMPLETED: '0',
      INSTALL_CLEANUP_ARMED: '1',
    },
  });

  assert.equal(result.status, 70, result.stderr);
  assert.equal(await readFile(join(releaseDir, 'keep-me'), 'utf8'), 'candidate remains\n');
  assert.equal(await readFile(releaseTgz, 'utf8'), 'upload remains while traffic is uncertain\n');
  assert.match(
    await readFile(join(value.stateDir, 'manual-recovery-required'), 'utf8'),
    /^failedLine=4321$/mu,
  );
});

test('production EXIT trap does not delete a candidate when pre-switch recovery is incomplete', async () => {
  const value = await fixture();
  const releaseDir = join(value.deployRoot, 'releases', 'candidate');
  await mkdir(releaseDir, { recursive: true });
  await writeFile(join(releaseDir, 'keep-me'), 'candidate remains\n');
  const releaseTgz = join(value.root, 'candidate.tgz');
  await writeFile(releaseTgz, 'upload remains\n');
  const onExit = await workflowFragment('on_exit() {', "trap 'on_error $LINENO' ERR");
  const harness = join(value.root, 'pre-switch-exit-wrapper.sh');
  await writeFile(
    harness,
    `#!/usr/bin/env bash
set -u
log() { :; }
restore_predeploy_systemd_units() { return 0; }
restore_predeploy_symlinks() { return 0; }
mark_manual_recovery() { return 0; }
${onExit}
set +e
(exit 23)
on_exit
`,
  );
  await chmod(harness, 0o755);
  const result = spawnSync('bash', [harness], {
    encoding: 'utf8',
    env: {
      ...value.environment,
      RELEASE_DIR: releaseDir,
      RELEASES_DIR: join(value.deployRoot, 'releases'),
      RELEASE_TGZ: releaseTgz,
      FAILURE_STATUS: '23',
      FAILURE_LINE: '4321',
      TRAFFIC_SWITCHED: '0',
      ROLLBACK_STATE_COMMITTED: '0',
      ROLLBACK_STATE_PRESERVE: '0',
      SYSTEMD_UNITS_DIRTY: '0',
      UNIT_RESTORE_FAILED: '0',
      SYMLINKS_DIRTY: '0',
      WORKER_SYMLINK_DIRTY: '0',
      FAILURE_RECOVERY_ACTIVE: '1',
      FAILURE_RECOVERY_COMPLETED: '0',
      INSTALL_CLEANUP_ARMED: '1',
    },
  });

  assert.equal(result.status, 70, result.stderr);
  assert.equal(await readFile(join(releaseDir, 'keep-me'), 'utf8'), 'candidate remains\n');
  assert.equal(await readFile(releaseTgz, 'utf8'), 'upload remains\n');
  assert.equal((await stat(value.stateDir)).isDirectory(), true);
});

test('post-switch failure before state commit preserves an auditable manual-recovery marker', async () => {
  const value = await fixture();
  const result = run('mark-manual-recovery', {
    ...value.environment,
    RELEASE_ID: 'rc-test',
    FAILED_STATUS: '42',
    FAILED_LINE: '2241',
  });

  assert.equal(result.status, 0, result.stderr);
  const markerPath = join(value.stateDir, 'manual-recovery-required');
  const marker = await readFile(markerPath, 'utf8');
  assert.match(marker, /^releaseId=rc-test$/mu);
  assert.match(marker, /^failedStatus=42$/mu);
  assert.match(marker, /^failedLine=2241$/mu);
  assert.match(marker, /^trafficSwitched=true$/mu);
  assert.match(marker, /^rollbackStateCommitted=false$/mu);
  assert.equal((await stat(markerPath)).mode & 0o777, 0o600);
  assert.equal(await readFile(value.serverUnit, 'utf8'), 'candidate server unit\n');
});
