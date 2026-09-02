import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const SCRIPT = resolve('scripts/deploy-acs-orchestrator.sh');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'acs-direct-rollback-'));
  const bin = join(root, 'bin');
  const previous = join(root, 'previous-release');
  const candidate = join(root, 'candidate-release');
  const etc = join(root, 'etc');
  await Promise.all([mkdir(bin), mkdir(previous), mkdir(candidate), mkdir(etc)]);

  const files = {
    envBak: join(root, 'acs.env.bak'),
    env: join(etc, 'acs.env'),
    runtimeConfigBak: join(root, 'runtime.json.bak'),
    runtimeConfig: join(etc, 'runtime.json'),
    identityBak: join(root, 'identity.json.bak'),
    identity: join(etc, 'identity.json'),
    runtimeIdentityBak: join(root, 'runtime-identity.json.bak'),
    runtimeIdentity: join(etc, 'runtime-identity.json'),
    operationState: join(root, 'snat-operation.json'),
    current: join(root, 'acs-current'),
    unitBak: join(root, 'acs-unit.bak'),
    unit: join(etc, 'acs.service'),
    log: join(root, 'commands.log'),
  };
  for (const [path, body] of [
    [files.envBak, 'previous env\n'],
    [files.env, 'candidate env\n'],
    [files.runtimeConfigBak, 'previous runtime\n'],
    [files.runtimeConfig, 'candidate runtime\n'],
    [files.identityBak, 'previous identity\n'],
    [files.identity, 'candidate identity\n'],
    [files.runtimeIdentityBak, 'previous runtime identity\n'],
    [files.runtimeIdentity, 'candidate runtime identity\n'],
    [files.operationState, '{}\n'],
    [files.unitBak, 'previous unit\n'],
    [files.unit, 'candidate unit\n'],
  ]) {
    await writeFile(path, body);
  }
  await symlink(candidate, files.current);

  const command = `#!/usr/bin/env bash
set -u
name="$(basename "$0")"
entry="$name $*"
printf '%s\\n' "$entry" >> "$ROLLBACK_LOG"
if [ -n "\${ROLLBACK_FAIL_MATCH:-}" ] && [[ "$entry" == *"$ROLLBACK_FAIL_MATCH"* ]]; then
  exit 42
fi
case "$name" in
  cp) /bin/cp "$@" ;;
  ln) /bin/ln "$@" ;;
  rm) /bin/rm "$@" ;;
  systemctl|curl) ;;
esac
`;
  for (const name of ['cp', 'ln', 'rm', 'systemctl', 'curl']) {
    const path = join(bin, name);
    await writeFile(path, command);
    await chmod(path, 0o755);
  }
  const restore = `#!/usr/bin/env bash
set -u
printf '%s\\n' "restore_acs_managed_unit $*" >> "$ROLLBACK_LOG"
if [ "\${ROLLBACK_FAIL_MATCH:-}" = 'restore_acs_managed_unit' ]; then exit 42; fi
printf '%s\\n' 'systemctl daemon-reload' >> "$ROLLBACK_LOG"
if [ "\${ROLLBACK_FAIL_MATCH:-}" = 'systemctl daemon-reload' ]; then exit 42; fi
`;
  await writeFile(join(bin, 'restore_acs_managed_unit'), restore);
  await chmod(join(bin, 'restore_acs_managed_unit'), 0o755);

  return {
    root,
    files,
    environment: {
      PATH: `${bin}:/usr/bin:/bin`,
      ROLLBACK_TEST_BIN: bin,
      ROLLBACK_LOG: files.log,
      PREVIOUS_APP_DIR: previous,
      APP_DIR: candidate,
      ENV_BAK: files.envBak,
      ENV_FILE: files.env,
      RUNTIME_CONFIG_BAK: files.runtimeConfigBak,
      RUNTIME_CONFIG_FILE: files.runtimeConfig,
      HAD_IDENTITY: 'true',
      IDENTITY_BAK: files.identityBak,
      IDENTITY_FILE: files.identity,
      RUNTIME_IDENTITY_UPDATED: 'true',
      RUNTIME_IDENTITY_BAK: files.runtimeIdentityBak,
      RUNTIME_IDENTITY_FILE: files.runtimeIdentity,
      CURRENT_LINK: files.current,
      CURRENT_LINK_UPDATED: 'true',
      SNAT_OPERATION_STATE_FILE: files.operationState,
      ACS_UNIT_UPDATED: 'true',
      ACS_UNIT_PATH: files.unit,
      ACS_UNIT_BAK: files.unitBak,
      ACS_UNIT_HAD_PREVIOUS: 'true',
      SYSTEMCTL_BIN: join(bin, 'systemctl'),
      ACS_SERVICE_NAME: 'agent-saas-acs-orchestrator.service',
      SNAT_ROLLBACK_SHARED_CONFIG_SAFE: 'true',
      SNAT_ROLLBACK_DIGEST: `sha256:${'a'.repeat(64)}`,
      SNAT_ROLLBACK_PREPARED: 'false',
      SNAT_ROLLBACK_OFFLINE_RESTORE: 'false',
      PROCESS_REPLACED: 'true',
      PRODUCTION_CLEANUP_ARMED: 'true',
      RELEASE_TGZ: join(root, 'unused-release.tgz'),
      SMOKE_SESSION: '',
      SMOKE_WORKSPACE_DIR: '',
      SMOKE_CLEANUP_ERROR: join(root, 'smoke-cleanup.err'),
      RUNTIME_PREFLIGHT_DIR: '',
      IMAGE: `registry.example.com/agent-saas@sha256:${'f'.repeat(64)}`,
      ROLLBACK_HEALTH_ATTEMPTS: '1',
      ROLLBACK_HEALTH_INTERVAL_SECONDS: '0',
    },
  };
}

async function runRollback(failure = '') {
  const value = await fixture();
  const result = spawnSync('bash', [SCRIPT, '--test-acs-direct-cleanup-trap'], {
    encoding: 'utf8',
    env: { ...process.env, ...value.environment, ROLLBACK_FAIL_MATCH: failure },
  });
  return { ...value, result, log: await readFile(value.files.log, 'utf8') };
}

test('production cleanup EXIT trap restores every boundary after an unwrapped failure', async () => {
  const value = await runRollback();
  assert.equal(value.result.status, 1, value.result.stderr);
  assert.match(value.log, /cp .*acs\.env\.bak/u);
  assert.match(value.log, /cp .*runtime\.json\.bak/u);
  assert.match(value.log, /cp .*runtime-identity\.json\.bak/u);
  assert.match(value.log, /ln -sfn .*acs-current/u);
  assert.match(value.log, /systemctl daemon-reload/u);
  assert.match(value.log, /systemctl restart agent-saas-acs-orchestrator\.service/u);
  await assert.rejects(lstat(value.files.unitBak));
});

for (const [label, failure, laterAction] of [
  ['environment restore', 'acs.env.bak', 'runtime.json.bak'],
  ['runtime config restore', 'runtime.json.bak', 'identity.json.bak'],
  ['release identity restore', 'identity.json.bak', 'runtime-identity.json.bak'],
  ['runtime identity restore', 'runtime-identity.json.bak', 'acs-current'],
  ['current link restore', 'acs-current', 'restore_acs_managed_unit'],
  ['managed unit restore', 'restore_acs_managed_unit', 'systemctl restart'],
  ['daemon reload', 'systemctl daemon-reload', 'systemctl restart'],
  ['previous service restart', 'systemctl restart', 'systemctl restart'],
]) {
  test(`${label} failure is consolidated after later ACS recovery actions`, async () => {
    const value = await runRollback(failure);
    assert.equal(value.result.status, 70, value.result.stderr);
    assert.match(value.result.stderr, /rollback status 70/u);
    assert.match(value.result.stderr, /completed with one or more recovery failures/u);
    assert.ok(value.log.includes(laterAction), `rollback did not continue to ${laterAction}`);
    assert.equal((await lstat(value.files.unitBak)).isFile(), true);
  });
}

test('ACS Token extraction streams through a checked pipe without a predictable temporary file', async () => {
  const script = await readFile(SCRIPT, 'utf8');
  assert.doesNotMatch(script, /RUNTIME_ENV_OUTPUT|agent-saas-runtime-environment/u);
  assert.match(script, /shopt -s lastpipe/u);
  assert.match(
    script,
    /--print-environment=ACS_ORCH_AUTH_TOKEN,ACS_KUBECONFIG,ACS_NAMESPACE \\\n\s+\| while IFS=/u,
  );
});
