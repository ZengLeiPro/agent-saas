import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const SCRIPT = resolve('scripts/release/deploy-production-release.sh');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'production-acs-rollback-'));
  const bin = join(root, 'bin');
  const rollbackRoot = join(root, 'rollback');
  const etc = join(root, 'etc');
  await Promise.all([mkdir(bin), mkdir(rollbackRoot), mkdir(etc)]);
  for (const file of [
    'acs-orchestrator.env',
    'acs-release-identity.json',
    'acs-orchestrator.service',
  ]) {
    await writeFile(join(rollbackRoot, file), `${file}\n`);
  }
  const command = `#!/usr/bin/env bash
set -u
name="$(basename "$0")"
printf '%s %s\\n' "$name" "$*" >> "$ROLLBACK_LOG"
entry="$name $*"
if [ -n "\${ROLLBACK_FAIL_MATCH:-}" ] && [[ "$entry" == *"$ROLLBACK_FAIL_MATCH"* ]]; then
  exit 42
fi
exit 0
`;
  for (const name of ['cp', 'ln', 'rm', 'systemctl']) {
    const path = join(bin, name);
    await writeFile(path, command);
    await chmod(path, 0o755);
  }
  return {
    root,
    rollbackRoot,
    log: join(root, 'commands.log'),
    environment: {
      PATH: `${bin}:/usr/bin:/bin`,
      ROLLBACK_LOG: join(root, 'commands.log'),
      rollback_root: rollbackRoot,
      previous: '/opt/agent-saas/acs-releases/previous',
      had_previous_identity: 'true',
      had_previous_unit: 'true',
      unit_path: join(etc, 'agent-saas-acs-orchestrator.service'),
      ACS_CURRENT_PATH: join(root, 'acs-current'),
      ACS_ENV_PATH: join(etc, 'acs-orchestrator.env'),
      ACS_IDENTITY_PATH: join(etc, 'acs-release-identity.json'),
      ACS_UNIT_PATH: join(etc, 'agent-saas-acs-orchestrator.service'),
      ACS_SERVICE_NAME: 'agent-saas-acs-orchestrator.service',
    },
  };
}

async function runCleanup(failure = '') {
  const value = await fixture();
  const failMatch = typeof failure === 'function' ? failure(value) : failure;
  const result = spawnSync('bash', [SCRIPT, '--test-acs-cleanup-trap'], {
    encoding: 'utf8',
    env: { ...process.env, ...value.environment, ROLLBACK_FAIL_MATCH: failMatch },
  });
  const log = await readFile(value.log, 'utf8');
  return { ...value, result, log };
}

function backupRemoval(value) {
  return `rm -rf ${value.rollbackRoot}`;
}

test('successful ACS rollback preserves deploy status and then removes its backup', async () => {
  const value = await runCleanup();
  assert.equal(value.result.status, 1, value.result.stderr);
  assert.match(value.log, /systemctl daemon-reload/u);
  assert.match(value.log, /systemctl restart agent-saas-acs-orchestrator\.service/u);
  assert.ok(value.log.includes(backupRemoval(value)));
});

for (const [label, failure, requiredLaterActions] of [
  [
    'current link restore',
    'ln -sfn /opt/agent-saas/acs-releases/previous',
    [
      'acs-orchestrator.env',
      'acs-release-identity.json',
      'acs-orchestrator.service',
      'systemctl daemon-reload',
      'systemctl restart agent-saas-acs-orchestrator.service',
    ],
  ],
  [
    'environment restore',
    (value) => `cp -a ${value.rollbackRoot}/acs-orchestrator.env`,
    [
      'acs-release-identity.json',
      'acs-orchestrator.service',
      'systemctl daemon-reload',
      'systemctl restart agent-saas-acs-orchestrator.service',
    ],
  ],
  [
    'identity restore',
    (value) => `cp -a ${value.rollbackRoot}/acs-release-identity.json`,
    [
      'acs-orchestrator.service',
      'systemctl daemon-reload',
      'systemctl restart agent-saas-acs-orchestrator.service',
    ],
  ],
  [
    'managed unit restore',
    (value) => `cp -a ${value.rollbackRoot}/acs-orchestrator.service`,
    ['systemctl daemon-reload', 'systemctl restart agent-saas-acs-orchestrator.service'],
  ],
  [
    'daemon reload',
    'systemctl daemon-reload',
    ['systemctl restart agent-saas-acs-orchestrator.service'],
  ],
  ['service restart', 'systemctl restart agent-saas-acs-orchestrator.service', []],
]) {
  test(`${label} failure is consolidated, continues recovery, and retains backup`, async () => {
    const value = await runCleanup(failure);
    assert.equal(value.result.status, 70, value.result.stderr);
    assert.match(value.result.stderr, /ACS rollback completed with one or more recovery failures/u);
    assert.match(value.result.stderr, /rollback status 70/u);
    for (const action of requiredLaterActions) {
      assert.ok(value.log.includes(action), `${basename(SCRIPT)} did not continue to ${action}`);
    }
    assert.equal(value.log.includes(backupRemoval(value)), false);
  });
}

// Execute the actual production snapshot and EXIT dispatcher after the function
// owning all rollback locals has returned. The old test-only entry point supplied
// globals and could not catch the production scope regression.
async function runAfterScopeExit(
  t,
  { mutated = false, committed = false, failure = '', cancelFailure = false } = {},
) {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const source = await readFile(SCRIPT, 'utf8');
  const deployStart = source.indexOf('deploy_acs() {');
  const snapshotStart = source.indexOf('  DEPLOY_ACS_ROLLBACK_COMMITTED=false', deployStart);
  const snapshotEnd = source.indexOf('  arm_deploy_rollback cleanup_acs_failure', snapshotStart);
  assert.ok(snapshotStart > deployStart && snapshotEnd > snapshotStart);
  const prefix = source.slice(0, source.indexOf('\nAPP_COLOR_ROOT='));
  const lifecycle = source.slice(
    source.indexOf('# BEGIN deploy rollback cleanup lifecycle'),
    source.indexOf('# END deploy rollback cleanup lifecycle'),
  );
  const names = [
    'previous',
    'rollback_root',
    'unit_path',
    'had_previous_identity',
    'had_previous_unit',
  ];
  const env = {
    ...process.env,
    ...value.environment,
    PHASE: 'acs',
    release_id: 'rc-20260912-131',
    manifest_digest: `sha256:${'a'.repeat(64)}`,
    GITHUB_RUN_ID: '34696842640',
    GITHUB_RUN_ATTEMPT: '1',
    PRECHANGE_RECOVERY_RECEIPT_PATH: join(value.root, 'prechange-acs.recovered'),
    ROLLBACK_RUNTIME_VERIFY: 'false',
    ROLLBACK_FAIL_MATCH: failure,
  };
  for (const name of names) {
    env['FIXTURE_' + name] = env[name];
    delete env[name];
  }
  delete env.acs_committed;
  delete env.acs_mutation_started;
  const shell = `${prefix}
${lifecycle}
mark_rollback_attempted() { :; }
emit_rollback_attempted_sentinel() { :; }
cancel_acs_deployment_drain() { return ${cancelFailure ? 1 : 0}; }
setup() {
  local acs_committed=false acs_mutation_started=false
${names.map((name) => `  local ${name}="$FIXTURE_${name}"`).join('\n')}
${source.slice(snapshotStart, snapshotEnd)}
  arm_deploy_rollback cleanup_acs_failure
  DEPLOY_ACS_ROLLBACK_MUTATION_STARTED=${mutated}
  DEPLOY_ACS_ROLLBACK_COMMITTED=${committed}
}
setup
# Fail only after locals have disappeared, exactly as in the real EXIT path.
exit ${mutated ? 20 : 75}
`;
  const result = spawnSync('bash', ['-c', shell], { encoding: 'utf8', env });
  const log = await readFile(value.log, 'utf8').catch(() => '');
  assert.doesNotMatch(result.stderr, /unbound variable/u);
  return { ...value, result, log };
}

test('ACS pre-cutover rejection survives scope exit without restarting healthy production', async (t) => {
  const value = await runAfterScopeExit(t);
  assert.equal(value.result.status, 75, value.result.stderr);
  assert.doesNotMatch(value.log, /systemctl|cp |ln /u);
  assert.ok(value.log.includes(backupRemoval(value)));
  assert.deepEqual(
    JSON.parse(await readFile(join(value.root, 'prechange-acs.recovered'), 'utf8')),
    {
      schemaVersion: 1,
      component: 'acs',
      state: 'prechange_recovered',
      releaseId: 'rc-20260912-131',
      manifestDigest: `sha256:${'a'.repeat(64)}`,
      runId: '34696842640',
      runAttempt: '1',
    },
  );
});

test('ACS post-mutation failure restores every snapshot boundary after scope exit', async (t) => {
  const value = await runAfterScopeExit(t, { mutated: true });
  assert.equal(value.result.status, 20, value.result.stderr);
  for (const action of [
    'ln -sfn',
    'acs-orchestrator.env',
    'acs-release-identity.json',
    'acs-orchestrator.service',
    'systemctl daemon-reload',
    'systemctl restart',
  ]) {
    assert.ok(value.log.includes(action), action);
  }
  assert.ok(value.log.includes(backupRemoval(value)));
});

test('ACS failed recovery after scope exit returns 70 and retains the snapshot', async (t) => {
  const value = await runAfterScopeExit(t, { mutated: true, failure: 'systemctl daemon-reload' });
  assert.equal(value.result.status, 70, value.result.stderr);
  assert.match(value.log, /systemctl restart/u);
  assert.equal(value.log.includes(backupRemoval(value)), false);
});

test('ACS drain cancellation failure retains evidence even before component mutation', async (t) => {
  const value = await runAfterScopeExit(t, { cancelFailure: true });
  assert.equal(value.result.status, 70, value.result.stderr);
  assert.equal(value.log.includes(backupRemoval(value)), false);
  await assert.rejects(readFile(join(value.root, 'prechange-acs.recovered'), 'utf8'), {
    code: 'ENOENT',
  });
});

test('ACS committed state prevents rollback even after deployment locals disappear', async (t) => {
  const value = await runAfterScopeExit(t, { mutated: true, committed: true });
  assert.equal(value.result.status, 20, value.result.stderr);
  assert.doesNotMatch(value.log, /systemctl|cp |ln /u);
  await assert.rejects(readFile(join(value.root, 'prechange-acs.recovered'), 'utf8'), {
    code: 'ENOENT',
  });
});
