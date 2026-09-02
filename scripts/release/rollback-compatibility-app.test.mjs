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

test('rollback defaults to the same managed API nginx site as compatibility deploy', async () => {
  assert.match(
    await readFile(SCRIPT, 'utf8'),
    /API_SITE_CONF="\$\{API_SITE_CONF:-\/etc\/nginx\/conf\.d\/agent-api-kaiyan\.conf\}"/u,
  );
});

async function fixture({ workerWasActive, nginxDropInPresent = true }) {
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
    nginxDropIn: join(etc, 'nginx-agent-saas-nas.conf'),
    identity: join(etc, 'runtime-identity.json'),
    upstream: join(etc, 'upstream.conf'),
    apiSite: join(etc, 'api-site.conf'),
    log: join(root, 'commands.log'),
    reloadCount: join(root, 'reload-count'),
    workerEnabled: join(root, 'worker-enabled'),
    workerRunning: join(root, 'worker-running'),
  };
  await Promise.all([
    writeFile(paths.active, 'blue\n'),
    writeFile(paths.workerActive, 'blue\n'),
    writeFile(paths.workerEnabled, 'agent-saas-runtime-worker@blue\n'),
    writeFile(paths.workerRunning, 'agent-saas-runtime-worker@blue\n'),
    writeFile(paths.serverUnit, 'ExecStartPre=/usr/bin/node dist/runtime-dependency.mjs\n'),
    writeFile(paths.workerUnit, 'ExecStartPre=/usr/bin/node dist/runtime-dependency.mjs\n'),
    writeFile(paths.nginxDropIn, 'candidate nginx drop-in\n'),
    writeFile(paths.identity, '{"release":"new"}\n'),
    writeFile(join(etc, 'server-blue.release.env'), 'AGENT_SAAS_RELEASE_SHA=new\n'),
    writeFile(join(etc, 'server-green.release.env'), 'current idle API env\n'),
    writeFile(join(etc, 'runtime-worker-blue.release.env'), 'AGENT_SAAS_RELEASE_SHA=new\n'),
    writeFile(join(etc, 'runtime-worker-green.release.env'), 'current idle Worker env\n'),
    writeFile(paths.upstream, 'current upstream\n'),
    writeFile(paths.apiSite, 'current api site\n'),
    writeFile(join(state, 'api-active-color'), 'green\n'),
    writeFile(join(state, 'api-release-target'), `${oldRelease}\n`),
    writeFile(join(state, 'server@.service'), 'ExecStart=/usr/bin/node legacy-server.js\n'),
    writeFile(join(state, 'runtime-identity.json'), '{"release":"old"}\n'),
    writeFile(join(state, 'api-env-present'), 'true\n'),
    writeFile(join(state, 'api.release.env'), 'AGENT_SAAS_RELEASE_SHA=old\n'),
    writeFile(join(state, 'worker-was-active'), `${workerWasActive}\n`),
    writeFile(join(state, 'worker-unit-present'), `${workerWasActive}\n`),
    writeFile(join(state, 'nginx-drop-in-present'), `${nginxDropInPresent}\n`),
    writeFile(join(state, 'api-site-present'), 'true\n'),
    writeFile(join(state, 'api-site.conf'), 'old api site\n'),
  ]);
  if (nginxDropInPresent) {
    await writeFile(join(state, 'nginx-agent-saas-nas.conf'), 'old nginx drop-in\n');
  }
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
service="${'$'}{*: -1}"
if [ "$1" = is-enabled ] && [[ "$service" = agent-saas-runtime-worker@* ]]; then
  [ "$(cat "$WORKER_ENABLED_STATE" 2>/dev/null || true)" = "$service" ]
  exit
fi
if [ "$1" = is-active ] && [[ "$service" = agent-saas-runtime-worker@* ]]; then
  [ "$(cat "$WORKER_RUNNING_STATE" 2>/dev/null || true)" = "$service" ]
  exit
fi
if [ "$1" = disable ] && [[ "$service" = agent-saas-runtime-worker@* ]]; then
  if [ "$(cat "$WORKER_ENABLED_STATE" 2>/dev/null || true)" = "$service" ]; then
    rm -f "$WORKER_ENABLED_STATE"
  fi
  if [ "$2" = --now ] && [ "$(cat "$WORKER_RUNNING_STATE" 2>/dev/null || true)" = "$service" ]; then
    rm -f "$WORKER_RUNNING_STATE"
  fi
fi
if [ "$1" = enable ] && [[ "$service" = agent-saas-runtime-worker@* ]]; then
  printf '%s\\n' "$service" > "$WORKER_ENABLED_STATE"
fi
if [ "$1" = restart ] && [[ "$service" = agent-saas-runtime-worker@* ]]; then
  printf '%s\\n' "$service" > "$WORKER_RUNNING_STATE"
fi
if [ "$1" = stop ] && [[ "$service" = agent-saas-runtime-worker@* ]]; then
  rm -f "$WORKER_RUNNING_STATE"
fi
if [ "$1" = is-active ] && [ "$service" = agent-saas-server@green ]; then exit 1; fi
if [ "$1" = restart ] && [ "$2" = agent-saas-runtime-worker@green ]; then
  printf '%s\\n' "$TEST_PID" > "$TEST_RUN/agent-saas-runtime-worker-green.pid"
  printf '%s\\n' "$TEST_PID" > "$TEST_RUN/agent-saas-runtime-worker-green.ready"
fi
if [ "$1" = show ] && [ "$2" = agent-saas-runtime-worker@green ]; then printf '%s\\n' "$TEST_PID"; fi
if [ "$1" = reload ] && [ "$2" = nginx ]; then
  count=$(cat "$RELOAD_COUNT_FILE" 2>/dev/null || echo 0)
  count=$((count + 1))
  printf '%s\n' "$count" > "$RELOAD_COUNT_FILE"
  if [ "${'$'}{FAIL_ALL_NGINX_RELOADS:-false}" = true ]; then exit 1; fi
  if [ "${'$'}{FAIL_FIRST_NGINX_RELOAD:-false}" = true ] && [ "$count" -eq 1 ]; then exit 1; fi
fi
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
      RELOAD_COUNT_FILE: paths.reloadCount,
      WORKER_ENABLED_STATE: paths.workerEnabled,
      WORKER_RUNNING_STATE: paths.workerRunning,
      TEST_PID: String(process.pid),
      TEST_RUN: run,
      ROOT: appRoot,
      ACTIVE_COLOR_FILE: paths.active,
      WORKER_ACTIVE_COLOR_FILE: paths.workerActive,
      UPSTREAM_CONF: paths.upstream,
      API_SITE_CONF: paths.apiSite,
      SERVER_UNIT_PATH: paths.serverUnit,
      WORKER_UNIT_PATH: paths.workerUnit,
      NGINX_DROP_IN_PATH: paths.nginxDropIn,
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

test('failed target nginx reload restores the complete current deployment topology', async () => {
  const value = await fixture({ workerWasActive: true });
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { ...value.environment, FAIL_FIRST_NGINX_RELOAD: 'true' },
  });

  assert.equal(result.status, 1);
  assert.equal(await readFile(value.paths.upstream, 'utf8'), 'current upstream\n');
  assert.equal(await readFile(value.paths.apiSite, 'utf8'), 'current api site\n');
  assert.equal(
    await readFile(value.paths.serverUnit, 'utf8'),
    'ExecStartPre=/usr/bin/node dist/runtime-dependency.mjs\n',
  );
  assert.equal(
    await readFile(value.paths.workerUnit, 'utf8'),
    'ExecStartPre=/usr/bin/node dist/runtime-dependency.mjs\n',
  );
  assert.equal(await readFile(value.paths.nginxDropIn, 'utf8'), 'candidate nginx drop-in\n');
  assert.equal(await readFile(value.paths.identity, 'utf8'), '{"release":"new"}\n');
  assert.equal(
    await readFile(join(value.paths.identity, '..', 'server-blue.release.env'), 'utf8'),
    'AGENT_SAAS_RELEASE_SHA=new\n',
  );
  assert.equal(
    await readFile(join(value.paths.identity, '..', 'server-green.release.env'), 'utf8'),
    'current idle API env\n',
  );
  assert.equal(
    await readFile(join(value.paths.identity, '..', 'runtime-worker-blue.release.env'), 'utf8'),
    'AGENT_SAAS_RELEASE_SHA=new\n',
  );
  assert.equal(
    await readFile(join(value.paths.identity, '..', 'runtime-worker-green.release.env'), 'utf8'),
    'current idle Worker env\n',
  );
  assert.equal(await readFile(value.paths.active, 'utf8'), 'blue\n');
  assert.equal(await readFile(value.paths.workerActive, 'utf8'), 'blue\n');
  assert.equal(
    await readFile(value.paths.workerEnabled, 'utf8'),
    'agent-saas-runtime-worker@blue\n',
  );
  assert.equal(
    await readFile(value.paths.workerRunning, 'utf8'),
    'agent-saas-runtime-worker@blue\n',
  );
  assert.equal(await readlink(join(value.appRoot, 'current')), value.newRelease);
  assert.equal(await readlink(join(value.appRoot, 'previous')), value.oldRelease);
  assert.equal(await readlink(join(value.appRoot, 'color', 'blue')), value.newRelease);
  assert.equal(await readlink(join(value.appRoot, 'color', 'green')), value.oldRelease);
  assert.equal(await readlink(join(value.appRoot, 'worker', 'blue')), value.newRelease);
  await assert.rejects(lstat(join(value.appRoot, 'worker', 'green')));
  assert.equal(await readFile(value.paths.reloadCount, 'utf8'), '2\n');
  const log = await readFile(value.paths.log, 'utf8');
  assert.match(log, /systemctl disable --now agent-saas-runtime-worker@green/u);
  assert.match(log, /systemctl enable agent-saas-runtime-worker@blue/u);
  assert.match(log, /systemctl restart agent-saas-runtime-worker@blue/u);
  assert.ok(
    log.indexOf('systemctl disable --now agent-saas-runtime-worker@green') <
      log.lastIndexOf('systemctl daemon-reload'),
  );
  assert.ok(
    log.lastIndexOf('systemctl daemon-reload') <
      log.indexOf('systemctl enable agent-saas-runtime-worker@blue'),
  );
  assert.doesNotMatch(log, /systemctl stop agent-saas-server@blue/u);
});

test('failed target and reverse nginx reloads leave auditable manual recovery state', async () => {
  const value = await fixture({ workerWasActive: false });
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { ...value.environment, FAIL_ALL_NGINX_RELOADS: 'true' },
  });

  assert.equal(result.status, 70);
  assert.equal(await readFile(value.paths.upstream, 'utf8'), 'current upstream\n');
  assert.equal(await readFile(value.paths.apiSite, 'utf8'), 'current api site\n');
  assert.equal(await readFile(value.paths.active, 'utf8'), 'blue\n');
  assert.equal(await readFile(value.paths.reloadCount, 'utf8'), '2\n');
  const marker = join(
    value.appRoot,
    'rollback-states',
    'new',
    'rollback-nginx-manual-recovery-required',
  );
  assert.equal((await lstat(marker)).mode & 0o777, 0o600);
  assert.match(await readFile(marker, 'utf8'), /target-nginx-reload-and-reverse-failed/u);
});

test('slow rollback removes the nginx drop-in when the previous deployment had none', async () => {
  const value = await fixture({ workerWasActive: false, nginxDropInPresent: false });
  const result = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: value.environment });

  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(lstat(value.paths.nginxDropIn));
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
    assert.equal(await readFile(value.paths.nginxDropIn, 'utf8'), 'old nginx drop-in\n');
    assert.equal(await readFile(value.paths.apiSite, 'utf8'), 'old api site\n');
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
