import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const SCRIPT = resolve('scripts/release/rollback-compatibility-app.sh');

async function fixture({ workerWasActive }) {
  const root = await mkdtemp(join(tmpdir(), 'compatibility-rollback-'));
  const appRoot = join(root, 'app');
  const releases = join(appRoot, 'releases');
  const oldRelease = join(releases, 'old');
  const newRelease = join(releases, 'new');
  const state = join(appRoot, 'rollback-states', 'new');
  const etc = join(root, 'etc');
  const run = join(root, 'run');
  const bin = join(root, 'bin');
  await Promise.all([
    mkdir(oldRelease, { recursive: true }),
    mkdir(newRelease, { recursive: true }),
    mkdir(state, { recursive: true, mode: 0o700 }),
    mkdir(join(appRoot, 'color'), { recursive: true }),
    mkdir(join(appRoot, 'worker'), { recursive: true }),
    mkdir(etc),
    mkdir(run),
    mkdir(bin),
  ]);
  await Promise.all([
    symlink(newRelease, join(appRoot, 'current')),
    symlink(oldRelease, join(appRoot, 'previous')),
    symlink(newRelease, join(appRoot, 'color', 'blue')),
    symlink(oldRelease, join(appRoot, 'color', 'green')),
    symlink(newRelease, join(appRoot, 'worker', 'blue')),
    symlink(state, join(appRoot, 'rollback-state')),
  ]);

  const paths = {
    active: join(etc, 'active-color'),
    workerActive: join(etc, 'runtime-worker-active-color'),
    serverUnit: join(etc, 'agent-saas-server@.service'),
    workerUnit: join(etc, 'agent-saas-runtime-worker@.service'),
    identity: join(etc, 'runtime-identity.json'),
    upstream: join(etc, 'upstream.conf'),
    log: join(root, 'commands.log'),
  };
  await Promise.all([
    writeFile(paths.active, 'blue\n'),
    writeFile(paths.workerActive, 'blue\n'),
    writeFile(paths.serverUnit, 'ExecStartPre=/usr/bin/node dist/runtime-dependency.mjs\n'),
    writeFile(paths.workerUnit, 'ExecStartPre=/usr/bin/node dist/runtime-dependency.mjs\n'),
    writeFile(paths.identity, '{"release":"new"}\n'),
    writeFile(join(state, 'api-active-color'), 'green\n'),
    writeFile(join(state, 'api-release-target'), `${oldRelease}\n`),
    writeFile(join(state, 'server@.service'), 'ExecStart=/usr/bin/node legacy-server.js\n'),
    writeFile(join(state, 'runtime-identity.json'), '{"release":"old"}\n'),
    writeFile(join(state, 'api-env-present'), 'true\n'),
    writeFile(join(state, 'api.release.env'), 'AGENT_SAAS_RELEASE_SHA=old\n'),
    writeFile(join(state, 'worker-was-active'), `${workerWasActive}\n`),
    writeFile(join(state, 'worker-unit-present'), `${workerWasActive}\n`),
  ]);
  if (workerWasActive) {
    await Promise.all([
      writeFile(
        join(state, 'runtime-worker@.service'),
        'ExecStart=/usr/bin/node legacy-worker.js\n',
      ),
      writeFile(join(state, 'worker-active-color'), 'green\n'),
      writeFile(join(state, 'worker-release-target'), `${oldRelease}\n`),
      writeFile(join(state, 'worker-env-present'), 'true\n'),
      writeFile(join(state, 'worker.release.env'), 'AGENT_SAAS_RELEASE_SHA=old\n'),
    ]);
  }

  const systemctl = join(bin, 'systemctl');
  await writeFile(
    systemctl,
    `#!/usr/bin/env bash
printf 'systemctl %s\\n' "$*" >> "$ROLLBACK_LOG"
if [ "$1" = is-active ] && [ "${'$'}{*: -1}" = agent-saas-server@green ]; then exit 1; fi
if [ "$1" = restart ] && [ "$2" = agent-saas-runtime-worker@green ]; then
  printf '%s\\n' "$TEST_PID" > "$TEST_RUN/agent-saas-runtime-worker-green.pid"
  printf '%s\\n' "$TEST_PID" > "$TEST_RUN/agent-saas-runtime-worker-green.ready"
fi
if [ "$1" = show ] && [ "$2" = agent-saas-runtime-worker@green ]; then printf '%s\\n' "$TEST_PID"; fi
exit 0
`,
  );
  const curl = join(bin, 'curl');
  await writeFile(curl, '#!/usr/bin/env bash\nexit 0\n');
  const nginx = join(bin, 'nginx');
  await writeFile(nginx, '#!/usr/bin/env bash\nprintf "nginx %s\\n" "$*" >> "$ROLLBACK_LOG"\n');
  await Promise.all([chmod(systemctl, 0o755), chmod(curl, 0o755), chmod(nginx, 0o755)]);

  return {
    root,
    appRoot,
    oldRelease,
    newRelease,
    paths,
    environment: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      ROLLBACK_LOG: paths.log,
      TEST_PID: String(process.pid),
      TEST_RUN: run,
      ROOT: appRoot,
      ACTIVE_COLOR_FILE: paths.active,
      WORKER_ACTIVE_COLOR_FILE: paths.workerActive,
      UPSTREAM_CONF: paths.upstream,
      SERVER_UNIT_PATH: paths.serverUnit,
      WORKER_UNIT_PATH: paths.workerUnit,
      RUNTIME_IDENTITY_FILE: paths.identity,
      RELEASE_ENV_ROOT: etc,
      RUN_DIR: run,
      READY_ATTEMPTS: '1',
      WORKER_READY_ATTEMPTS: '1',
    },
  };
}

async function runRollback(workerWasActive) {
  const value = await fixture({ workerWasActive });
  const result = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: value.environment });
  return { ...value, result, log: await readFile(value.paths.log, 'utf8') };
}

test('rollback fails closed before restoring units when the current Worker marker is missing', async () => {
  const value = await fixture({ workerWasActive: false });
  await rm(value.paths.workerActive);
  const result = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: value.environment });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /current Runtime Worker color is missing/u);
  assert.match(await readFile(value.paths.serverUnit, 'utf8'), /runtime-dependency/u);
});

for (const workerWasActive of [true, false]) {
  test(`slow rollback restores the pre-guard release when prior Worker active=${workerWasActive}`, async () => {
    const value = await runRollback(workerWasActive);
    assert.equal(value.result.status, 0, value.result.stderr);
    assert.equal(
      await readFile(value.paths.serverUnit, 'utf8'),
      'ExecStart=/usr/bin/node legacy-server.js\n',
    );
    assert.doesNotMatch(await readFile(value.paths.serverUnit, 'utf8'), /runtime-dependency/u);
    assert.equal(await readFile(value.paths.identity, 'utf8'), '{"release":"old"}\n');
    assert.equal(await readFile(value.paths.active, 'utf8'), 'green\n');
    assert.equal(await readlink(join(value.appRoot, 'current')), value.oldRelease);
    assert.equal(await readlink(join(value.appRoot, 'previous')), value.newRelease);
    assert.equal(await readlink(join(value.appRoot, 'color', 'green')), value.oldRelease);
    assert.match(value.log, /systemctl disable --now agent-saas-runtime-worker@blue/u);
    assert.ok(
      value.log.indexOf('systemctl daemon-reload') <
        value.log.indexOf('systemctl start agent-saas-server@green'),
    );
    assert.match(value.log, /systemctl start agent-saas-server@green/u);
    if (workerWasActive) {
      assert.equal(
        await readFile(value.paths.workerUnit, 'utf8'),
        'ExecStart=/usr/bin/node legacy-worker.js\n',
      );
      assert.equal(await readFile(value.paths.workerActive, 'utf8'), 'green\n');
      assert.match(value.log, /systemctl restart agent-saas-runtime-worker@green/u);
    } else {
      await assert.rejects(lstat(value.paths.workerUnit));
      await assert.rejects(lstat(value.paths.workerActive));
      assert.doesNotMatch(value.log, /runtime-worker@green/u);
    }
  });
}
