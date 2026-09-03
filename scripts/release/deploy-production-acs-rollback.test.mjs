import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
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
