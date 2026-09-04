import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const SCRIPT = resolve('scripts/release/deploy-production-release.sh');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'production-app-rollback-'));
  const bin = join(root, 'bin');
  const rollbackRoot = join(root, 'rollback');
  await Promise.all([
    mkdir(bin),
    mkdir(rollbackRoot),
    mkdir(join(root, 'color')),
    mkdir(join(root, 'worker')),
    mkdir(join(root, 'etc')),
  ]);
  for (const file of [
    'api.release.env',
    'worker.release.env',
    'server@.service',
    'runtime-worker@.service',
    'nginx-upstream.conf',
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
`;
  for (const name of ['cp', 'ln', 'rm', 'nginx', 'systemctl']) {
    const path = join(bin, name);
    const action = ['cp', 'ln', 'rm'].includes(name) ? `exec /usr/bin/${name} "$@"\n` : 'exit 0\n';
    await writeFile(path, `${command}${action}`);
    await chmod(path, 0o755);
  }
  await writeFile(join(root, 'etc/active-color'), 'green\n');
  await writeFile(join(root, 'etc/runtime-worker-active-color'), 'green\n');
  return {
    root,
    bin,
    rollbackRoot,
    log: join(root, 'commands.log'),
    environment: {
      PATH: `${bin}:/usr/bin:/bin`,
      ROLLBACK_LOG: join(root, 'commands.log'),
      rollback_root: rollbackRoot,
      api_idle: 'green',
      worker_idle: 'green',
      api_active: 'blue',
      worker_active: 'blue',
      api_idle_previous: '/opt/releases/previous-api',
      worker_idle_previous: '/opt/releases/previous-worker',
      api_env: join(root, 'etc/server-green.release.env'),
      worker_env: join(root, 'etc/runtime-worker-green.release.env'),
      had_api_env: 'true',
      had_worker_env: 'true',
      nginx_changed: 'true',
      server_unit: join(root, 'etc/agent-saas-server@.service'),
      worker_unit: join(root, 'etc/agent-saas-runtime-worker@.service'),
      APP_COLOR_ROOT: join(root, 'color'),
      APP_WORKER_ROOT: join(root, 'worker'),
      ACTIVE_COLOR_PATH: join(root, 'etc/active-color'),
      WORKER_ACTIVE_COLOR_PATH: join(root, 'etc/runtime-worker-active-color'),
      NGINX_UPSTREAM_PATH: join(root, 'etc/nginx-upstream.conf'),
    },
  };
}

async function runRollback(failMatch = '', mode = '--test-app-rollback') {
  const value = await fixture();
  const result = spawnSync('bash', [SCRIPT, mode], {
    encoding: 'utf8',
    env: { ...process.env, ...value.environment, ROLLBACK_FAIL_MATCH: failMatch },
  });
  const log = await readFile(value.log, 'utf8');
  return { ...value, result, log };
}

test('App rollback prepares disk boundaries without publishing unverified authority', async () => {
  const value = await runRollback();
  assert.equal(value.result.status, 0, value.result.stderr);
  assert.match(value.log, /systemctl daemon-reload/u);
  assert.match(value.log, /rm -f \/run\/agent-saas-server-blue\.draining/u);
  assert.match(value.log, /rm -f \/run\/agent-saas-runtime-worker-blue\.draining/u);
  assert.doesNotMatch(value.log, /systemctl (?:restart|reload|enable|disable)/u);
  assert.doesNotMatch(value.log, /nginx -t/u);
  assert.doesNotMatch(
    value.log,
    new RegExp(`cp -a ${join(value.rollbackRoot, 'nginx-upstream.conf')}`),
  );
  assert.equal((await readFile(join(value.root, 'etc/active-color'), 'utf8')).trim(), 'green');
  assert.equal(
    (await readFile(join(value.root, 'etc/runtime-worker-active-color'), 'utf8')).trim(),
    'green',
  );
});

test('EXIT trap preserves deploy failure unless consolidated rollback fails with status 70', async () => {
  const cleanRollback = await runRollback('', '--test-app-cleanup-trap');
  assert.equal(cleanRollback.result.status, 1, cleanRollback.result.stderr);

  const failedRollback = await runRollback('api.release.env', '--test-app-cleanup-trap');
  assert.equal(failedRollback.result.status, 70, failedRollback.result.stderr);
  assert.match(failedRollback.result.stderr, /rollback status 70/u);
  assert.match(failedRollback.log, /rm -f \/run\/agent-saas-runtime-worker-blue\.draining/u);
});

for (const [label, failure, requiredLaterActions] of [
  [
    'environment restore',
    'api.release.env',
    [
      'worker.release.env',
      'systemctl daemon-reload',
      'rm -f /run/agent-saas-runtime-worker-blue.draining',
    ],
  ],
  [
    'managed unit restore',
    'server@.service',
    [
      'runtime-worker@.service',
      'systemctl daemon-reload',
      'rm -f /run/agent-saas-runtime-worker-blue.draining',
    ],
  ],
  [
    'daemon reload',
    'systemctl daemon-reload',
    [
      'rm -f /run/agent-saas-server-blue.draining',
      'rm -f /run/agent-saas-runtime-worker-blue.draining',
    ],
  ],
  [
    'draining marker cleanup',
    'rm -f /run/agent-saas-server-blue.draining',
    ['rm -f /run/agent-saas-runtime-worker-blue.draining'],
  ],
]) {
  test(`${label} failure is consolidated after all later recovery actions`, async () => {
    const value = await runRollback(failure);
    assert.equal(value.result.status, 70, value.result.stderr);
    assert.match(value.result.stderr, /rollback completed with one or more recovery failures/u);
    for (const action of requiredLaterActions) {
      assert.ok(value.log.includes(action), `${basename(SCRIPT)} did not continue to ${action}`);
    }
  });
}
