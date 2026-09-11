import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, chmod, mkdir, rm, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { verifyPromotionObservation } from './verify-promotion-observation.mjs';
import { assertPromotionPhaseState } from './verify-promotion-phase-state.mjs';
import { reconcilePromotion } from './reconcile-promotion.mjs';

const deploy = await readFile(new URL('./deploy-production-release.sh', import.meta.url), 'utf8');
const route = deploy.slice(
  deploy.indexOf('validate_api_routing_boundary() {'),
  deploy.indexOf('\nread_release_id_from_env() {'),
);
const holder = new URL('./hold-production-observation-lock.sh', import.meta.url).pathname;
let serial = 0;
function run(command, args, env, cwd = process.cwd()) {
  const child = spawn(command, args, { env: { ...process.env, ...env }, cwd });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (value) => {
    stdout += value;
  });
  child.stderr.on('data', (value) => {
    stderr += value;
  });
  const result = once(child, 'close').then(([code, signal]) => ({ code, signal, stdout, stderr }));
  return { child, result };
}
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function until(predicate) {
  for (let i = 0; i < 150; i += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('fixture did not become ready');
}
function matrix(character) {
  const sha = character.repeat(40),
    digest = `sha256:${character.repeat(64)}`;
  return {
    web: { gitSha: sha, artifactDigest: digest },
    api: { gitSha: sha, artifactDigest: digest },
    runtimeWorker: { gitSha: sha, artifactDigest: digest },
    acs: { gitSha: sha, orchestratorArtifactDigest: digest, sandboxImageDigest: digest },
  };
}
function fixture() {
  const before = { components: matrix('a') },
    target = matrix('b');
  const source = (components) =>
    Object.fromEntries(
      Object.entries(components).map(([name, { gitSha, ...rest }]) => [
        name,
        { sourceSha: gitSha, ...rest },
      ]),
    );
  const manifest = {
    schemaVersion: 2,
    components: source(target),
    productionBaseline: source(before.components),
  };
  for (const value of Object.values(manifest.components)) value.action = 'deploy';
  const live = {
    schemaVersion: 1,
    environment: 'production',
    configIdentity: { status: 'consistent', releaseId: 'rc-20260911-116' },
    components: structuredClone(before.components),
  };
  live.components.acs = target.acs;
  return { manifest, before, live, target };
}

for (const mode of [
  'transient',
  'wrong-release',
  'permanent-503',
  'forbidden',
  'malformed',
  'stalled',
  'marker-drift',
]) {
  test(`routed readiness with real curl: ${mode}`, { timeout: 10000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'route-ready-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    let calls = 0;
    const body = {
      status: 'ok',
      release: { environment: 'production', releaseId: 'rc-20260911-117', safetyAttested: true },
    };
    const server = createServer(async (_req, res) => {
      calls += 1;
      if (mode === 'stalled') return;
      if (mode === 'marker-drift')
        await writeFile(join(root, 'upstream'), '# active=green release=unexpected\n');
      const old = mode === 'wrong-release' || (mode === 'transient' && calls === 2);
      res.statusCode =
        mode === 'forbidden'
          ? 403
          : mode === 'permanent-503' || (mode === 'transient' && calls === 1)
            ? 503
            : 200;
      res.end(
        mode === 'malformed'
          ? 'PRIVATE_BODY_NOT_TO_LOG'
          : JSON.stringify({
              ...body,
              release: {
                ...body.release,
                releaseId: old ? 'rc-20260911-116' : body.release.releaseId,
              },
            }),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    await writeFile(join(root, 'upstream'), '# active=blue release=rc-20260911-117\n');
    const script = `${route}
systemctl() { return 0; }
nginx() { return 0; }
curl() {
  local args=() arg
  for arg in "$@"; do
    [ "$arg" != https://127.0.0.1/api/healthz/ready ] || arg="http://127.0.0.1:$FIXTURE_PORT/ready"
    args+=("$arg")
  done
  command curl "\${args[@]}"
}
validate_api_routing_boundary blue rc-20260911-117
`;
    const value = await run('bash', ['-c', script], {
      FIXTURE_PORT: String(server.address().port),
      AGENT_SAAS_NGINX_UPSTREAM_FILE: join(root, 'upstream'),
      API_ROUTED_READY_WAIT_SECONDS: mode === 'transient' ? '5' : '1',
    }).result;
    assert.equal(value.code === 0, mode === 'transient', value.stderr);
    assert.doesNotMatch(value.stderr, /PRIVATE_BODY_NOT_TO_LOG/);
    if (mode === 'transient') assert.equal(calls, 3);
    if (mode === 'forbidden' || mode === 'malformed' || mode === 'marker-drift')
      assert.equal(calls, 1);
    if (mode === 'permanent-503' || mode === 'wrong-release' || mode === 'stalled')
      assert.match(value.stderr, /bounded deadline/);
  });
}

test('observation permits compensated matrices without weakening forward Web gate or side-effect gates', () => {
  const f = fixture();
  assert.throws(() => assertPromotionPhaseState(f.manifest, f.live, 'web'), /Production changed/);
  assert.deepEqual(verifyPromotionObservation(f.manifest, f.before, f.live).components, {
    acs: 'target',
    app: 'before',
    web: 'before',
  });
  const outcome = reconcilePromotion({
    releaseId: 'rc-20260911-117',
    before: f.before.components,
    target: f.target,
    observed: f.live.components,
    observationComplete: true,
    externalSideEffects: 'unknown',
    rollbackReceipts: {
      acs: { attempted: false, succeeded: false },
      app: { attempted: true, succeeded: true },
      web: { attempted: false, succeeded: false },
    },
  });
  assert.equal(outcome.outcome, 'needs_human');
  assert.equal(outcome.componentResults.app.rollbackVerified, true);
  assert.equal(outcome.componentResults.acs.state, 'target');
});

test('every component-level before/target combination is observable; unknown and split identities cannot be committed', () => {
  for (let bits = 0; bits < 8; bits += 1) {
    const f = fixture();
    for (const [index, names] of [['acs'], ['api', 'runtimeWorker'], ['web']].entries()) {
      for (const name of names)
        f.live.components[name] = (bits & (1 << index) ? f.target : f.before.components)[name];
    }
    assert.equal(verifyPromotionObservation(f.manifest, f.before, f.live).targetMatch, bits === 7);
  }
  for (const breakFixture of [
    (f) => {
      f.live.components.api = f.target.api;
    },
    (f) => {
      f.live.components.acs = matrix('c').acs;
    },
    (f) => {
      delete f.live.components.web.artifactDigest;
    },
    (f) => {
      f.live.configIdentity.status = 'mismatch';
    },
    (f) => {
      f.live.environment = 'staging';
    },
    (f) => {
      f.manifest.components.web.action = 'keep';
    },
  ]) {
    const f = fixture();
    breakFixture(f);
    assert.throws(() => verifyPromotionObservation(f.manifest, f.before, f.live));
  }
});

async function lockFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'observation-lock-'));
  const id = `${process.pid}${++serial}`;
  const prefix = `/tmp/agent-saas-promotion-${id}-1-identity-lock`;
  const env = {
    GITHUB_RUN_ID: id,
    GITHUB_RUN_ATTEMPT: '1',
    OBSERVATION_LOCK_READY: `${prefix}.ready`,
    OBSERVATION_LOCK_RELEASE: `${prefix}.release`,
    PRODUCTION_LOCK_FILE: join(root, 'promotion.lock'),
    OBSERVATION_LOCK_TIMEOUT_SECONDS: '5',
  };
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(env.OBSERVATION_LOCK_READY, { force: true });
    await rm(env.OBSERVATION_LOCK_RELEASE, { force: true });
  });
  return { root, env };
}

for (const mode of ['release', 'cancel', 'deadline']) {
  test(`observation lock with real flock: ${mode}`, { timeout: 10000 }, async (t) => {
    const { root, env } = await lockFixture(t);
    if (mode === 'deadline') env.OBSERVATION_LOCK_TIMEOUT_SECONDS = '1';
    const evidence = join(root, 'rollback-app.succeeded');
    await writeFile(evidence, 'untouched');
    const first = run('bash', [holder], env);
    t.after(() => first.child.kill('SIGTERM'));
    await until(() => exists(env.OBSERVATION_LOCK_READY));
    const conflicting = await run('bash', [holder], env).result;
    assert.notEqual(conflicting.code, 0);
    assert.equal(
      await exists(env.OBSERVATION_LOCK_READY),
      true,
      'conflict cannot clear owner handshake',
    );
    if (mode === 'release') await writeFile(env.OBSERVATION_LOCK_RELEASE, '');
    if (mode === 'cancel') first.child.kill('SIGTERM');
    const result = await first.result;
    assert.equal(result.code, { release: 0, cancel: 130, deadline: 70 }[mode], result.stderr);
    assert.equal(await exists(env.OBSERVATION_LOCK_READY), false);
    assert.equal(await readFile(evidence, 'utf8'), 'untouched');
    assert.equal((await run('flock', ['-n', env.PRODUCTION_LOCK_FILE, 'true'], {}).result).code, 0);
  });
}

for (const unknown of [false, true]) {
  test(
    `actual workflow readback survives App rollback; unknown=${unknown}`,
    { timeout: 15000 },
    async (t) => {
      const { root, env } = await lockFixture(t);
      const f = fixture();
      if (unknown) f.live.components.web = matrix('c').web;
      await mkdir(join(root, 'bin'));
      for (const [name, data] of Object.entries({
        'manifest.json': f.manifest,
        'production-before.json': f.before,
        'live.json': f.live,
      }))
        await writeFile(join(root, name), JSON.stringify(data));
      const workflow = await readFile(
        new URL('../../.github/workflows/promote-release.yml', import.meta.url),
        'utf8',
      );
      const block = workflow
        .split('- name: 读取全部在线组件并仅在完全收敛后提交可信身份')[1]
        .split('- name: 核对组件结果')[0];
      const commands = block
        .slice(block.indexOf('run: |') + 'run: |'.length)
        .split('\n')
        .map((line) => line.replace(/^ {10}/, ''))
        .join('\n');
      // Only SSH transport is replaced. The real runner lease, holder, snapshot gate,
      // jq projections and cleanup all execute, without cloud credentials or writes.
      const ssh = `#!/usr/bin/env bash
set -euo pipefail
cmd="\${!#}"
case "$cmd" in
  *"PHASE=web "*)
    exec node "$FIXTURE_REPO/scripts/release/verify-promotion-phase-state.mjs" "$FIXTURE_ROOT/manifest.json" "$FIXTURE_ROOT/live.json" web ;;
  *hold-production-observation-lock.sh*)
    cmd="\${cmd/ sudo / env }"
    exec bash -c "$cmd" ;;
  *"sudo test -f "*) exec bash -c "\${cmd#sudo }" ;;
  *"sudo touch "*) exec bash -c "\${cmd#sudo }" ;;
  *read-live-production-components.mjs*) cat "$FIXTURE_ROOT/live.json" ;;
  *write-live-production-identity.mjs*) echo partial >> "$FIXTURE_ROOT/writes" ;;
  *write-production-identity.mjs*) echo target >> "$FIXTURE_ROOT/writes" ;;
  *read-production-state.mjs*) cat "$FIXTURE_ROOT/live.json" ;;
  *) echo 'unexpected SSH command' >&2; exit 99 ;;
esac
`;
      await writeFile(join(root, 'bin', 'ssh'), ssh);
      await chmod(join(root, 'bin', 'ssh'), 0o755);
      await writeFile(join(root, 'hold-production-observation-lock.sh'), await readFile(holder));
      const value = await run(
        'bash',
        ['-c', commands],
        {
          ...env,
          FIXTURE_ROOT: root,
          FIXTURE_REPO: resolve('.'),
          RUNNER_TEMP: root,
          PROMOTION_REMOTE: root,
          ECS_USER: 'fixture',
          ECS_HOST: 'unused',
          RELEASE_ID: 'rc-20260911-117',
          PRODUCTION_DEPLOYMENT_ID: '123',
          MANIFEST_DIGEST: `sha256:${'d'.repeat(64)}`,
          GITHUB_OUTPUT: join(root, 'output'),
          PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        },
        resolve('.'),
      ).result;
      assert.equal(value.code === 0, !unknown, value.stderr);
      assert.deepEqual(
        JSON.parse(await readFile(join(root, 'production-after.json'), 'utf8')),
        f.live,
      );
      assert.equal(
        await exists(env.OBSERVATION_LOCK_READY),
        false,
        'lease cleaned up on either outcome',
      );
      if (unknown) assert.equal(await exists(join(root, 'writes')), false);
      else {
        assert.equal(await readFile(join(root, 'writes'), 'utf8'), 'partial\n');
        assert.match(await readFile(join(root, 'output'), 'utf8'), /target_match=false/);
      }
    },
  );
}
