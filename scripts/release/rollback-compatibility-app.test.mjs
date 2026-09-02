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
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const SCRIPT = resolve('scripts/release/rollback-compatibility-app.sh');

test('rollback defaults to the same managed API nginx site as compatibility deploy', async () => {
  assert.match(
    await readFile(SCRIPT, 'utf8'),
    /API_SITE_CONF="\$\{API_SITE_CONF:-\/etc\/nginx\/conf\.d\/agent-api-kaiyan\.conf\}"/u,
  );
});

async function fixture({
  workerWasActive,
  nginxDropInPresent = true,
  targetServerWasActive = false,
  targetWorkerWasActive = false,
}) {
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
    daemonReloadCount: join(root, 'daemon-reload-count'),
    targetReadyCount: join(root, 'target-ready-count'),
    workerEnabled: join(root, 'worker-enabled-blue'),
    workerEnabledGreen: join(root, 'worker-enabled-green'),
    workerRunning: join(root, 'worker-running-blue'),
    workerRunningGreen: join(root, 'worker-running-green'),
    serverEnabledBlue: join(root, 'server-enabled-blue'),
    serverEnabledGreen: join(root, 'server-enabled-green'),
    serverRunningBlue: join(root, 'server-running-blue'),
    serverRunning: join(root, 'server-running-green'),
  };
  await Promise.all([
    writeFile(paths.active, 'blue\n'),
    writeFile(paths.workerActive, 'blue\n'),
    writeFile(paths.workerEnabled, 'agent-saas-runtime-worker@blue\n'),
    writeFile(paths.workerRunning, 'agent-saas-runtime-worker@blue\n'),
    writeFile(paths.serverEnabledBlue, 'agent-saas-server@blue\n'),
    writeFile(paths.serverRunningBlue, 'agent-saas-server@blue\n'),
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
  if (targetServerWasActive) {
    await writeFile(paths.serverRunning, 'agent-saas-server@green\n');
  }
  if (targetWorkerWasActive) {
    await Promise.all([
      writeFile(paths.workerEnabledGreen, 'agent-saas-runtime-worker@green\n'),
      writeFile(paths.workerRunningGreen, 'agent-saas-runtime-worker@green\n'),
    ]);
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
if [ "$1" = daemon-reload ]; then
  count=$(cat "$DAEMON_RELOAD_COUNT_FILE" 2>/dev/null || echo 0)
  count=$((count + 1))
  printf '%s\\n' "$count" > "$DAEMON_RELOAD_COUNT_FILE"
  if [ "${'$'}{FAIL_FIRST_DAEMON_RELOAD:-false}" = true ] && [ "$count" -eq 1 ]; then exit 5; fi
fi
service="${'$'}{*: -1}"
server_enabled_state=''
server_running_state=''
worker_enabled_state=''
worker_running_state=''
case "$service" in
  agent-saas-server@blue)
    server_enabled_state="$SERVER_ENABLED_BLUE_STATE"
    server_running_state="$SERVER_RUNNING_BLUE_STATE"
    ;;
  agent-saas-server@green)
    server_enabled_state="$SERVER_ENABLED_GREEN_STATE"
    server_running_state="$SERVER_RUNNING_STATE"
    ;;
  agent-saas-runtime-worker@blue)
    worker_enabled_state="$WORKER_ENABLED_BLUE_STATE"
    worker_running_state="$WORKER_RUNNING_BLUE_STATE"
    ;;
  agent-saas-runtime-worker@green)
    worker_enabled_state="$WORKER_ENABLED_GREEN_STATE"
    worker_running_state="$WORKER_RUNNING_GREEN_STATE"
    ;;
esac
if [ "$1" = is-enabled ] && [[ "$service" = agent-saas-server@* ]]; then
  if [ "${'$'}{FAIL_SERVER_IS_ENABLED:-false}" = true ]; then echo failed; exit 5; fi
  if [ "$(cat "$server_enabled_state" 2>/dev/null || true)" = "$service" ]; then
    echo enabled
    exit 0
  fi
  echo disabled
  exit 1
fi
if [ "$1" = is-enabled ] && [[ "$service" = agent-saas-runtime-worker@* ]]; then
  if [ "${'$'}{FAIL_WORKER_IS_ENABLED:-false}" = true ]; then echo failed; exit 5; fi
  if [ "$(cat "$worker_enabled_state" 2>/dev/null || true)" = "$service" ]; then
    echo enabled
    exit 0
  fi
  echo disabled
  exit 1
fi
if [ "$1" = is-active ] && [[ "$service" = agent-saas-runtime-worker@* ]]; then
  if [ "${'$'}{FAIL_WORKER_IS_ACTIVE:-false}" = true ]; then echo failed; exit 5; fi
  if [ "$(cat "$worker_running_state" 2>/dev/null || true)" = "$service" ]; then
    echo active
    exit 0
  fi
  echo inactive
  exit 3
fi
if [ "$1" = disable ] && [[ "$service" = agent-saas-runtime-worker@* ]]; then
  if [ "$(cat "$worker_enabled_state" 2>/dev/null || true)" = "$service" ]; then
    rm -f "$worker_enabled_state"
  fi
  if [ "$2" = --now ] && [ "$(cat "$worker_running_state" 2>/dev/null || true)" = "$service" ]; then
    rm -f "$worker_running_state"
  fi
fi
if [ "$1" = enable ] && [[ "$service" = agent-saas-runtime-worker@* ]]; then
  printf '%s\\n' "$service" > "$worker_enabled_state"
fi
if [ "$1" = restart ] && [[ "$service" = agent-saas-runtime-worker@* ]]; then
  printf '%s\\n' "$service" > "$worker_running_state"
fi
if [ "$1" = stop ] && [[ "$service" = agent-saas-runtime-worker@* ]]; then
  rm -f "$worker_running_state"
fi
if [ "$1" = is-active ] && [[ "$service" = agent-saas-server@* ]]; then
  if [ "$service" = agent-saas-server@green ] \
    && [ "${'$'}{FAIL_SERVER_IS_ACTIVE:-false}" = true ]; then echo failed; exit 5; fi
  if [ "$service" = agent-saas-server@blue ] \
    && [ "${'$'}{FAIL_CURRENT_SERVER_IS_ACTIVE:-false}" = true ]; then echo failed; exit 5; fi
  if [ "$(cat "$server_running_state" 2>/dev/null || true)" = "$service" ]; then
    echo active
    exit 0
  fi
  echo inactive
  exit 3
fi
if [ "$1" = enable ] && [[ "$service" = agent-saas-server@* ]]; then
  printf '%s\\n' "$service" > "$server_enabled_state"
  if [ "$service" = agent-saas-server@green ] \
    && [ "${'$'}{FAIL_TARGET_SERVER_ENABLE_AFTER_EFFECT:-false}" = true ]; then
    exit 5
  fi
  if [ "$service" = agent-saas-server@blue ] \
    && [ "${'$'}{FAIL_CURRENT_SERVER_ENABLE_AFTER_EFFECT:-false}" = true ]; then
    exit 5
  fi
fi
if [ "$1" = disable ] && [[ "$service" = agent-saas-server@* ]]; then
  rm -f "$server_enabled_state"
  if [ "$service" = agent-saas-server@blue ] \
    && [ "${'$'}{FAIL_CURRENT_SERVER_DISABLE_AFTER_EFFECT:-false}" = true ]; then
    exit 5
  fi
fi
if [ "$1" = start ] && [ "$service" = agent-saas-server@green ]; then
  printf '%s\\n' "$service" > "$SERVER_RUNNING_STATE"
  if [ "${'$'}{FAIL_TARGET_SERVER_START_AFTER_EFFECT:-false}" = true ]; then exit 5; fi
fi
if [ "$1" = restart ] && [ "$service" = agent-saas-server@green ]; then
  printf '%s\\n' "$service" > "$SERVER_RUNNING_STATE"
fi
if [ "$1" = stop ] && [ "$service" = agent-saas-server@green ]; then
  rm -f "$SERVER_RUNNING_STATE"
  if [ "${'$'}{FAIL_TARGET_SERVER_STOP_AFTER_EFFECT:-false}" = true ]; then exit 5; fi
fi
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
  if [ "${'$'}{FAIL_SECOND_NGINX_RELOAD:-false}" = true ] && [ "$count" -eq 2 ]; then exit 1; fi
fi
exit 0
`,
  );
  const curl = join(bin, 'curl');
  await writeFile(
    curl,
    `#!/usr/bin/env bash
if [[ "$*" = *"127.0.0.1:3200/api/healthz/ready"* ]] \
  && [ "${'$'}{CURRENT_SERVER_READY:-true}" = false ]; then
  exit 1
fi
if [[ "$*" = *"127.0.0.1:3201/api/healthz/ready"* ]] \
  && [ "${'$'}{TARGET_SERVER_READY:-true}" = false ]; then
  exit 1
fi
if [[ "$*" = *"127.0.0.1:3200/api/healthz/ready"* ]]; then
  printf '{"release":{"releaseSha":"new"}}\\n'
fi
if [[ "$*" = *"127.0.0.1:3201/api/healthz/ready"* ]]; then
  count=$(cat "$TARGET_READY_COUNT_FILE" 2>/dev/null || echo 0)
  count=$((count + 1))
  printf '%s\\n' "$count" > "$TARGET_READY_COUNT_FILE"
  release_sha="${'$'}{TARGET_RELEASE_SHA:-old}"
  if [ "$count" -gt 1 ] && [ -n "${'$'}{TARGET_RELEASE_SHA_AFTER_FIRST:-}" ]; then
    release_sha="$TARGET_RELEASE_SHA_AFTER_FIRST"
  fi
  printf '{"release":{"releaseSha":"%s"}}\\n' "$release_sha"
fi
if [[ "$*" = *"/api/healthz/drain"* ]]; then
  if [ "${'$'}{FAIL_TARGET_DRAIN:-false}" = true ]; then exit 1; fi
  if [ "${'$'}{TARGET_DRAIN_BUSY:-false}" = true ]; then
    printf '{"activeStreams":1,"activeUploads":0,"activeRuns":{"blocking":0},"idle":false}\\n'
  else
    printf '{"activeStreams":0,"activeUploads":0,"activeRuns":{"blocking":0},"idle":true}\\n'
  fi
fi
exit 0
`,
  );
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
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      ROLLBACK_LOG: paths.log,
      RELOAD_COUNT_FILE: paths.reloadCount,
      DAEMON_RELOAD_COUNT_FILE: paths.daemonReloadCount,
      TARGET_READY_COUNT_FILE: paths.targetReadyCount,
      WORKER_ENABLED_BLUE_STATE: paths.workerEnabled,
      WORKER_ENABLED_GREEN_STATE: paths.workerEnabledGreen,
      WORKER_RUNNING_BLUE_STATE: paths.workerRunning,
      WORKER_RUNNING_GREEN_STATE: paths.workerRunningGreen,
      SERVER_ENABLED_BLUE_STATE: paths.serverEnabledBlue,
      SERVER_ENABLED_GREEN_STATE: paths.serverEnabledGreen,
      SERVER_RUNNING_BLUE_STATE: paths.serverRunningBlue,
      SERVER_RUNNING_STATE: paths.serverRunning,
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

test('rollback preserves an unresolved manual recovery marker without mutation', async () => {
  const value = await fixture({ workerWasActive: false });
  const marker = join(
    value.appRoot,
    'rollback-states',
    'new',
    'rollback-nginx-manual-recovery-required',
  );
  await writeFile(marker, 'existing incident evidence\n');
  const result = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: value.environment });

  assert.equal(result.status, 70, `${result.stdout}\n${result.stderr}`);
  assert.equal(await readFile(marker, 'utf8'), 'existing incident evidence\n');
  await assert.rejects(readFile(value.paths.log, 'utf8'));
});

test('rollback fails closed before restoring units when the current Worker marker is missing', async () => {
  const value = await fixture({ workerWasActive: false });
  await rm(value.paths.workerActive);
  const result = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: value.environment });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /current Runtime Worker color is missing/u);
  assert.match(await readFile(value.paths.serverUnit, 'utf8'), /runtime-dependency/u);
});

for (const failureFlag of ['FAIL_WORKER_IS_ENABLED', 'FAIL_WORKER_IS_ACTIVE']) {
  test(`systemd Worker query failure ${failureFlag} stops before any topology mutation`, async () => {
    const value = await fixture({ workerWasActive: false, targetServerWasActive: true });
    const result = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: {
        ...value.environment,
        TARGET_SERVER_READY: 'false',
        [failureFlag]: 'true',
      },
    });

    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /failed to query whether .* is (enabled|active)/u);
    assert.match(await readFile(value.paths.serverUnit, 'utf8'), /runtime-dependency/u);
    assert.equal(await readFile(value.paths.identity, 'utf8'), '{"release":"new"}\n');
    assert.equal(await readlink(join(value.appRoot, 'current')), value.newRelease);
    assert.equal(await readlink(join(value.appRoot, 'previous')), value.oldRelease);
    assert.equal(await readFile(value.paths.workerActive, 'utf8'), 'blue\n');
    assert.equal(
      await readFile(value.paths.workerEnabled, 'utf8'),
      'agent-saas-runtime-worker@blue\n',
    );
    assert.equal(
      await readFile(value.paths.workerRunning, 'utf8'),
      'agent-saas-runtime-worker@blue\n',
    );
    assert.equal(await readFile(value.paths.serverRunning, 'utf8'), 'agent-saas-server@green\n');
    const log = await readFile(value.paths.log, 'utf8');
    assert.doesNotMatch(log, /systemctl stop agent-saas-server@green/u);
    assert.doesNotMatch(log, /systemctl disable --now/u);
  });
}

test('systemd target Server query failures stop before any topology mutation', async () => {
  const value = await fixture({ workerWasActive: false });
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { ...value.environment, FAIL_SERVER_IS_ACTIVE: 'true' },
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /failed to query whether .* is active/u);
  const log = await readFile(value.paths.log, 'utf8');
  assert.doesNotMatch(log, /systemctl stop|systemctl disable --now|systemctl start/u);
});

test('systemd Server enablement query failure stops before any topology mutation', async () => {
  const value = await fixture({ workerWasActive: false, targetServerWasActive: true });
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { ...value.environment, FAIL_SERVER_IS_ENABLED: 'true' },
  });

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /failed to query whether .* is enabled/u);
  assert.equal(await readlink(join(value.appRoot, 'current')), value.newRelease);
  assert.equal(await readFile(value.paths.serverRunning, 'utf8'), 'agent-saas-server@green\n');
  const log = await readFile(value.paths.log, 'utf8');
  assert.doesNotMatch(log, /systemctl stop|systemctl disable --now|systemctl start/u);
});

test('rollback refuses to interrupt a target Server with verified blocking drain activity', async () => {
  const value = await fixture({ workerWasActive: false, targetServerWasActive: true });
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { ...value.environment, TARGET_DRAIN_BUSY: 'true' },
  });

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /verified drain state is busy/u);
  assert.equal(await readFile(value.paths.serverRunning, 'utf8'), 'agent-saas-server@green\n');
  const log = await readFile(value.paths.log, 'utf8');
  assert.doesNotMatch(log, /systemctl stop|systemctl disable --now|systemctl start/u);
});

for (const marker of [
  '{"activeStreams":0,"activeUploads":0,"runtimeQuiesced":false}\n',
  '{"activeStreams":0,"activeUploads":0}\n',
]) {
  test(`fallback drain marker must prove runtime quiescence: ${marker.trim()}`, async () => {
    const value = await fixture({ workerWasActive: false, targetServerWasActive: true });
    const draining = join(value.root, 'run', 'agent-saas-server-green.draining');
    await writeFile(draining, marker);
    const result = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: { ...value.environment, FAIL_TARGET_DRAIN: 'true' },
    });

    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /verified drain state is busy/u);
    assert.equal(await readFile(value.paths.serverRunning, 'utf8'), 'agent-saas-server@green\n');
    const log = await readFile(value.paths.log, 'utf8');
    assert.doesNotMatch(log, /systemctl stop|systemctl disable --now|systemctl start/u);
  });
}

test('target Server stop side effect is reversed even when systemctl reports failure', async () => {
  const value = await fixture({ workerWasActive: false, targetServerWasActive: true });
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...value.environment,
      TARGET_SERVER_READY: 'false',
      FAIL_TARGET_SERVER_STOP_AFTER_EFFECT: 'true',
    },
  });

  assert.equal(result.status, 5, `${result.stdout}\n${result.stderr}`);
  assert.equal(await readFile(value.paths.serverRunning, 'utf8'), 'agent-saas-server@green\n');
  assert.equal(await readFile(value.paths.serverEnabledBlue, 'utf8'), 'agent-saas-server@blue\n');
  await assert.rejects(lstat(value.paths.serverEnabledGreen));
  const log = await readFile(value.paths.log, 'utf8');
  assert.match(log, /systemctl stop agent-saas-server@green/u);
  assert.match(log, /systemctl restart agent-saas-server@green/u);
});

test('target Server start side effect is reversed even when systemctl reports failure', async () => {
  const value = await fixture({ workerWasActive: false });
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { ...value.environment, FAIL_TARGET_SERVER_START_AFTER_EFFECT: 'true' },
  });

  assert.equal(result.status, 5, `${result.stdout}\n${result.stderr}`);
  await assert.rejects(lstat(value.paths.serverRunning));
  assert.equal(await readFile(value.paths.serverEnabledBlue, 'utf8'), 'agent-saas-server@blue\n');
  await assert.rejects(lstat(value.paths.serverEnabledGreen));
  const log = await readFile(value.paths.log, 'utf8');
  assert.match(log, /systemctl start agent-saas-server@green/u);
  assert.match(log, /systemctl stop agent-saas-server@green/u);
});

test('prepare mutation failure restores the complete pre-rollback topology', async () => {
  const value = await fixture({ workerWasActive: false });
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { ...value.environment, FAIL_FIRST_DAEMON_RELOAD: 'true' },
  });

  assert.equal(result.status, 5, `${result.stdout}\n${result.stderr}`);
  assert.match(await readFile(value.paths.serverUnit, 'utf8'), /runtime-dependency/u);
  assert.equal(await readFile(value.paths.identity, 'utf8'), '{"release":"new"}\n');
  assert.equal(await readlink(join(value.appRoot, 'current')), value.newRelease);
  assert.equal(await readlink(join(value.appRoot, 'previous')), value.oldRelease);
  assert.equal(await readFile(value.paths.workerActive, 'utf8'), 'blue\n');
  assert.equal(
    await readFile(value.paths.workerEnabled, 'utf8'),
    'agent-saas-runtime-worker@blue\n',
  );
  assert.equal(
    await readFile(value.paths.workerRunning, 'utf8'),
    'agent-saas-runtime-worker@blue\n',
  );
  assert.equal(await readFile(value.paths.daemonReloadCount, 'utf8'), '2\n');
});

for (const failureFlag of [
  'FAIL_TARGET_SERVER_ENABLE_AFTER_EFFECT',
  'FAIL_CURRENT_SERVER_DISABLE_AFTER_EFFECT',
]) {
  test(`post-switch Server enablement failure ${failureFlag} reverses traffic and unit state`, async () => {
    const value = await fixture({ workerWasActive: false });
    const result = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: { ...value.environment, [failureFlag]: 'true' },
    });

    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.equal(await readFile(value.paths.upstream, 'utf8'), 'current upstream\n');
    assert.equal(await readFile(value.paths.apiSite, 'utf8'), 'current api site\n');
    assert.equal(await readFile(value.paths.active, 'utf8'), 'blue\n');
    assert.equal(await readFile(value.paths.serverEnabledBlue, 'utf8'), 'agent-saas-server@blue\n');
    await assert.rejects(lstat(value.paths.serverEnabledGreen));
    await assert.rejects(lstat(value.paths.serverRunning));
    assert.equal(await readFile(value.paths.reloadCount, 'utf8'), '2\n');
  });
}

test('successful identity-matched fast path revalidates and preserves the running target pid', async () => {
  const value = await fixture({ workerWasActive: false, targetServerWasActive: true });
  const targetPid = join(value.root, 'run', 'agent-saas-server-green.pid');
  await writeFile(targetPid, `${process.pid}\n`);

  const result = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: value.environment });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await readFile(targetPid, 'utf8'), `${process.pid}\n`);
  assert.equal(await readFile(value.paths.targetReadyCount, 'utf8'), '2\n');
  const log = await readFile(value.paths.log, 'utf8');
  assert.doesNotMatch(log, /systemctl stop agent-saas-server@green/u);
  assert.doesNotMatch(log, /systemctl start agent-saas-server@green/u);
});

test('fast path aborts when target identity changes immediately before traffic switch', async () => {
  const value = await fixture({ workerWasActive: false, targetServerWasActive: true });
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { ...value.environment, TARGET_RELEASE_SHA_AFTER_FIRST: 'unexpected-release' },
  });

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /identity\/readiness changed before traffic switch/u);
  assert.equal(await readFile(value.paths.targetReadyCount, 'utf8'), '2\n');
  assert.equal(await readFile(value.paths.serverRunning, 'utf8'), 'agent-saas-server@green\n');
  await assert.rejects(readFile(value.paths.reloadCount, 'utf8'));
});

test('ready target with a persistent release mismatch never receives traffic', async () => {
  const value = await fixture({ workerWasActive: false, targetServerWasActive: true });
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { ...value.environment, TARGET_RELEASE_SHA: 'unexpected-release' },
  });

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /readiness identity does not match rollback release SHA/u);
  assert.equal(await readFile(value.paths.serverRunning, 'utf8'), 'agent-saas-server@green\n');
  await assert.rejects(readFile(value.paths.reloadCount, 'utf8'));
  const log = await readFile(value.paths.log, 'utf8');
  assert.match(log, /systemctl stop agent-saas-server@green/u);
  assert.match(log, /systemctl start agent-saas-server@green/u);
  assert.match(log, /systemctl restart agent-saas-server@green/u);
});

test('failed reversal preserves a target Server that may still own live nginx traffic', async () => {
  const value = await fixture({ workerWasActive: false });
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...value.environment,
      FAIL_TARGET_SERVER_ENABLE_AFTER_EFFECT: 'true',
      FAIL_SECOND_NGINX_RELOAD: 'true',
    },
  });

  assert.equal(result.status, 70, `${result.stdout}\n${result.stderr}`);
  assert.equal(await readFile(value.paths.serverRunning, 'utf8'), 'agent-saas-server@green\n');
  assert.equal(await readFile(value.paths.active, 'utf8'), 'green\n');
  const log = await readFile(value.paths.log, 'utf8');
  assert.doesNotMatch(log, /systemctl stop agent-saas-server@green/u);
  const marker = join(
    value.appRoot,
    'rollback-states',
    'new',
    'rollback-nginx-manual-recovery-required',
  );
  assert.match(await readFile(marker, 'utf8'), /target-server-enable-and-runtime-reverse-failed/u);
});

test('runtime reversal refuses to stop the target when the current Server is unavailable', async () => {
  const value = await fixture({ workerWasActive: false });
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...value.environment,
      FAIL_TARGET_SERVER_ENABLE_AFTER_EFFECT: 'true',
      FAIL_CURRENT_SERVER_IS_ACTIVE: 'true',
    },
  });

  assert.equal(result.status, 70, `${result.stdout}\n${result.stderr}`);
  assert.equal(await readFile(value.paths.serverRunning, 'utf8'), 'agent-saas-server@green\n');
  assert.equal(await readFile(value.paths.active, 'utf8'), 'green\n');
  assert.equal(await readFile(value.paths.reloadCount, 'utf8'), '1\n');
  const log = await readFile(value.paths.log, 'utf8');
  assert.doesNotMatch(log, /systemctl stop agent-saas-server@green/u);
});

test('active marker write failure is explicit and keeps the live target Server', async () => {
  const value = await fixture({ workerWasActive: false });
  await mkdir(`${value.paths.active}.candidate`);
  const result = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: value.environment });

  assert.equal(result.status, 70, `${result.stdout}\n${result.stderr}`);
  assert.equal(await readFile(value.paths.active, 'utf8'), 'blue\n');
  assert.equal(await readFile(value.paths.serverRunning, 'utf8'), 'agent-saas-server@green\n');
  const marker = join(
    value.appRoot,
    'rollback-states',
    'new',
    'rollback-nginx-manual-recovery-required',
  );
  assert.match(await readFile(marker, 'utf8'), /active-marker-update-and-nginx-reverse-failed/u);
});

test('failed post-switch enablement recovery exits 70 and records manual recovery', async () => {
  const value = await fixture({ workerWasActive: false });
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...value.environment,
      FAIL_TARGET_SERVER_ENABLE_AFTER_EFFECT: 'true',
      FAIL_CURRENT_SERVER_ENABLE_AFTER_EFFECT: 'true',
    },
  });

  assert.equal(result.status, 70, `${result.stdout}\n${result.stderr}`);
  assert.equal(await readFile(value.paths.upstream, 'utf8'), 'current upstream\n');
  assert.equal(await readFile(value.paths.active, 'utf8'), 'blue\n');
  const marker = join(
    value.appRoot,
    'rollback-states',
    'new',
    'rollback-nginx-manual-recovery-required',
  );
  assert.equal((await lstat(marker)).mode & 0o777, 0o600);
  assert.match(await readFile(marker, 'utf8'), /target-server-enable-and-runtime-reverse-failed/u);
});

test('failed nginx switch restores both Worker instances to their original states', async () => {
  const value = await fixture({
    workerWasActive: true,
    targetWorkerWasActive: true,
  });
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { ...value.environment, FAIL_FIRST_NGINX_RELOAD: 'true' },
  });

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.equal(
    await readFile(value.paths.workerEnabled, 'utf8'),
    'agent-saas-runtime-worker@blue\n',
  );
  assert.equal(
    await readFile(value.paths.workerRunning, 'utf8'),
    'agent-saas-runtime-worker@blue\n',
  );
  assert.equal(
    await readFile(value.paths.workerEnabledGreen, 'utf8'),
    'agent-saas-runtime-worker@green\n',
  );
  assert.equal(
    await readFile(value.paths.workerRunningGreen, 'utf8'),
    'agent-saas-runtime-worker@green\n',
  );
});

test('failed rollback restores pre-existing Server and Worker draining markers', async () => {
  const value = await fixture({
    workerWasActive: true,
    targetServerWasActive: true,
    targetWorkerWasActive: true,
  });
  const serverDraining = join(value.root, 'run', 'agent-saas-server-green.draining');
  const workerDraining = join(value.root, 'run', 'agent-saas-runtime-worker-green.draining');
  await writeFile(serverDraining, '{"activeUploads":0}\n');
  await writeFile(workerDraining, 'draining\n');
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...value.environment,
      TARGET_SERVER_READY: 'false',
      FAIL_FIRST_NGINX_RELOAD: 'true',
    },
  });

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.equal(await readFile(serverDraining, 'utf8'), '{"activeUploads":0}\n');
  assert.equal(await readFile(workerDraining, 'utf8'), 'draining\n');
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
  assert.equal(await readFile(value.paths.serverEnabledBlue, 'utf8'), 'agent-saas-server@blue\n');
  await assert.rejects(lstat(value.paths.serverEnabledGreen));
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
  await assert.rejects(lstat(value.paths.serverRunning));
  assert.equal(await readFile(value.paths.reloadCount, 'utf8'), '2\n');
  const log = await readFile(value.paths.log, 'utf8');
  assert.match(log, /systemctl disable agent-saas-runtime-worker@green/u);
  assert.match(log, /systemctl stop agent-saas-runtime-worker@green/u);
  assert.match(log, /systemctl enable agent-saas-runtime-worker@blue/u);
  assert.match(log, /systemctl restart agent-saas-runtime-worker@blue/u);
  assert.match(log, /systemctl stop agent-saas-server@green/u);
  assert.ok(
    log.lastIndexOf('systemctl reload nginx') <
      log.indexOf('systemctl stop agent-saas-server@green'),
  );
  assert.ok(
    log.lastIndexOf('systemctl daemon-reload') <
      log.indexOf('systemctl disable agent-saas-runtime-worker@green'),
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
  assert.equal(await readFile(value.paths.serverRunning, 'utf8'), 'agent-saas-server@green\n');
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

test('slow target readiness failure stops a Server started by this rollback', async () => {
  const value = await fixture({ workerWasActive: true });
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { ...value.environment, TARGET_SERVER_READY: 'false' },
  });

  assert.equal(result.status, 1);
  await assert.rejects(lstat(value.paths.serverRunning));
  assert.match(await readFile(value.paths.serverUnit, 'utf8'), /runtime-dependency/u);
  assert.equal(await readFile(value.paths.identity, 'utf8'), '{"release":"new"}\n');
  assert.equal(await readlink(join(value.appRoot, 'current')), value.newRelease);
  assert.equal(await readFile(value.paths.workerActive, 'utf8'), 'blue\n');
});

test('slow readiness failure restores a target Server that was active before rollback', async () => {
  const value = await fixture({ workerWasActive: true, targetServerWasActive: true });
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { ...value.environment, TARGET_SERVER_READY: 'false' },
  });

  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.equal(await readFile(value.paths.serverRunning, 'utf8'), 'agent-saas-server@green\n');
  const log = await readFile(value.paths.log, 'utf8');
  assert.match(log, /systemctl restart agent-saas-server@green/u);
});

test('failed fast-path reload keeps a target Server that was already active', async () => {
  const value = await fixture({ workerWasActive: true, targetServerWasActive: true });
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: { ...value.environment, FAIL_FIRST_NGINX_RELOAD: 'true' },
  });

  assert.equal(result.status, 1);
  assert.equal(await readFile(value.paths.serverRunning, 'utf8'), 'agent-saas-server@green\n');
  const log = await readFile(value.paths.log, 'utf8');
  assert.doesNotMatch(log, /systemctl stop agent-saas-server@green/u);
});

test('slow rollback removes the nginx drop-in when the previous deployment had none', async () => {
  const value = await fixture({ workerWasActive: false, nginxDropInPresent: false });
  const result = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: value.environment });

  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(lstat(value.paths.nginxDropIn));
});

test('rollback without a Worker stops both pre-existing Worker instances', async () => {
  const value = await fixture({ workerWasActive: false, targetWorkerWasActive: true });
  const result = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: value.environment });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  await assert.rejects(lstat(value.paths.workerEnabled));
  await assert.rejects(lstat(value.paths.workerRunning));
  await assert.rejects(lstat(value.paths.workerEnabledGreen));
  await assert.rejects(lstat(value.paths.workerRunningGreen));
  const log = await readFile(value.paths.log, 'utf8');
  assert.match(log, /systemctl disable --now agent-saas-runtime-worker@blue/u);
  assert.match(log, /systemctl disable --now agent-saas-runtime-worker@green/u);
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
      assert.doesNotMatch(value.log, /systemctl (enable|restart) agent-saas-runtime-worker@green/u);
    }
  });
}
