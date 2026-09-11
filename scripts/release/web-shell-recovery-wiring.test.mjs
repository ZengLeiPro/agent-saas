import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { inspectJournal, saveJournal } from './web-recovery-journal.mjs';

const exec = promisify(execFile);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const identity = {
  releaseId: 'rc-20260911-01',
  manifestDigest: 'sha256:' + 'a'.repeat(64),
  runId: '123',
  runAttempt: '1',
};
const source = resolve('scripts/release');
const cold = '/opt/agent-saas-web-recovery/releases/old-release';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'web-recovery-wiring-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin'),
    remote = join(root, 'remote'),
    host = join(root, 'host'),
    runner = join(root, 'new-runner');
  for (const path of [bin, remote, runner]) await mkdir(path);
  // Replace only the host storage root in a byte-for-byte copy; no production config escape hatch.
  const journal = (await readFile(join(source, 'web-recovery-journal.mjs'), 'utf8')).replace(
    "'/var/lib/agent-saas-release-recovery/web'",
    JSON.stringify(host),
  );
  await writeFile(join(remote, 'web-recovery-journal.mjs'), journal);
  await writeFile(
    join(bin, 'node'),
    `#!/usr/bin/env bash\nset -euo pipefail\nif [[ "$1" = */web-shell-transaction.mjs ]]; then\n  printf '%s\\n' "$*" >> "$FIXTURE_CALLS"\n  if [ "\${FAIL_PHASE:-}" = "$2" ]; then exit 71; fi\n  echo '{"verified":true,"objects":[]}'\nelse exec '${process.execPath}' "$@"; fi\n`,
    { mode: 0o700 },
  );
  const key = 'index.html',
    file = hash(key) + '.bin';
  const capsule = {
    schemaVersion: 1,
    recoveryBefore: cold,
    snapshot: {
      schemaVersion: 1,
      identity,
      entries: [
        {
          key,
          file,
          existed: true,
          digest: hash('old'),
          targetDigest: hash('new'),
          metadata: { 'cache-control': 'no-cache' },
        },
      ],
    },
    files: { [file]: Buffer.from('old').toString('base64') },
  };
  const env = {
    ...process.env,
    PATH: bin + ':' + process.env.PATH,
    PROMOTION_REMOTE: remote,
    RUNNER_TEMP: runner,
    RELEASE_ID: identity.releaseId,
    MANIFEST_DIGEST: identity.manifestDigest,
    GITHUB_RUN_ID: '999',
    GITHUB_RUN_ATTEMPT: '2',
    PRODUCTION_WEB_OSS_URI: 'oss://isolated-fixture',
    RELEASE_RECORD_OSS_REGION: 'fixture-region',
    FIXTURE_CALLS: join(root, 'calls'),
    HOST_LOCK_HELD: 'true',
  };
  const setup = `set -euo pipefail
    recovery_ssh() {
      if [[ "$1" = *rollback-recovery-web.sh* ]]; then
        printf '%s\\n' "$1" >> "$FIXTURE_CALLS"
        [ "\${FAIL_PHASE:-}" != cold ]
      else bash -euo pipefail -c "\${1#sudo }"; fi
    }
    run_with_web_lock() {
      [ "$HOST_LOCK_HELD" = true ] || return 73
      # Match production's asynchronous fenced child: inherited stdin is /dev/null.
      "$@" < /dev/null & local pid=$!; wait "$pid"
    }
    export -f recovery_ssh run_with_web_lock
    source '${source}/web-shell-recovery.sh'
  `;
  return {
    root,
    host,
    runner,
    capsule,
    env,
    run: (body, extra = {}) =>
      exec('bash', ['-c', setup + body], {
        env: { ...env, ...extra },
        timeout: 15000,
        maxBuffer: 100000,
      }),
  };
}

test('Bash wiring persists input inside the fenced child before acknowledging backup readiness', async (t) => {
  const f = await fixture(t);
  const backup = join(f.runner, 'web-before');
  await mkdir(backup);
  await writeFile(join(backup, 'snapshot.json'), JSON.stringify(f.capsule.snapshot));
  for (const [name, bytes] of Object.entries(f.capsule.files))
    await writeFile(join(backup, name), Buffer.from(bytes, 'base64'));
  await writeFile(join(f.runner, 'recovery-web-target.before'), cold);
  await f.run('persist_web_recovery');
  const state = await inspectJournal(f.host, identity.releaseId, identity.manifestDigest);
  assert.equal(state.pending, true);
  assert.deepEqual(state.identity, identity);
  assert.equal(
    JSON.parse(await readFile(join(f.runner, 'web-recovery-readback.json'), 'utf8')).capsuleDigest,
    state.capsuleDigest,
  );
});

test('fresh-runner Bash recovery uses original run/attempt for both cold and OSS rollback', async (t) => {
  const f = await fixture(t);
  await saveJournal(f.host, f.capsule);
  await f.run('recover_previous_web_transaction');
  const calls = (await readFile(f.env.FIXTURE_CALLS, 'utf8')).trim().split('\n');
  assert.equal(calls.length, 3);
  assert.match(calls[0], /verify-restore/);
  assert.match(calls[0], /123 1 fixture-region$/);
  assert.match(calls[1], /RUN_ID='123\.1'/);
  assert.match(calls[2], / restore /);
  assert.match(calls[2], /123 1 fixture-region$/);
  assert.equal(
    (await inspectJournal(f.host, identity.releaseId, identity.manifestDigest)).state,
    'rolled_back',
  );
  assert.equal(
    await readFile(join(f.runner, 'web-original-before', hash('index.html') + '.bin'), 'utf8'),
    'old',
  );
});

for (const phase of ['verify-restore', 'cold', 'restore'])
  test(`recovery failure at ${phase} retains the durable pending barrier`, async (t) => {
    const f = await fixture(t);
    await saveJournal(f.host, f.capsule);
    await assert.rejects(f.run('recover_previous_web_transaction', { FAIL_PHASE: phase }));
    assert.equal(
      (await inspectJournal(f.host, identity.releaseId, identity.manifestDigest)).pending,
      true,
    );
    const calls = (await readFile(f.env.FIXTURE_CALLS, 'utf8')).trim().split('\n');
    assert.equal(calls.length, phase === 'verify-restore' ? 1 : phase === 'cold' ? 2 : 3);
  });

test('no host lock means no cross-run recovery operations', async (t) => {
  const f = await fixture(t);
  await saveJournal(f.host, f.capsule);
  await assert.rejects(f.run('recover_previous_web_transaction', { HOST_LOCK_HELD: 'false' }));
  await assert.rejects(readFile(f.env.FIXTURE_CALLS), { code: 'ENOENT' });
  assert.equal(
    (await inspectJournal(f.host, identity.releaseId, identity.manifestDigest)).pending,
    true,
  );
});

for (const [alreadyTarget, pending, skips] of [
  ['true', true, false],
  ['true', false, true],
  ['false', true, false],
  ['false', false, false],
])
  test(`actual workflow never skips a pending recovery: alreadyTarget=${alreadyTarget}, pending=${pending}`, async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.runner, 'web-recovery-state.json'), JSON.stringify({ pending }));
    const workflow = await readFile('.github/workflows/promote-release.yml', 'utf8');
    const body = workflow.match(
      /if \[ "\$WEB_ALREADY_TARGET" = true \] && \[.*?\n[\s\S]*?exit 0\n\s+fi/u,
    )?.[0];
    assert.ok(body, 'the real pending-aware fast path must exist');
    const result = await f.run(body + '\necho CONTINUE_RECOVERY', {
      WEB_ALREADY_TARGET: alreadyTarget,
    });
    assert.equal(result.stdout.includes('CONTINUE_RECOVERY'), !skips);
  });

for (const acknowledged of [true, false])
  test(`actual workflow treats lost durable-commit acknowledgement as unknown, not rollback: ack=${acknowledged}`, async (t) => {
    const f = await fixture(t);
    const workflow = await readFile('.github/workflows/promote-release.yml', 'utf8');
    const begin = workflow.lastIndexOf('          web_lock_is_alive\n');
    const end =
      workflow.indexOf('          web_committed=true', begin) +
      '          web_committed=true'.length;
    assert.ok(begin >= 0 && end > begin);
    const actual = workflow.slice(begin, end);
    const body = `web_backup_ready=true; web_committed=false
      trap 'printf "backup=%s committed=%s\\n" "$web_backup_ready" "$web_committed" > "$RUNNER_TEMP/commit-result"' EXIT
      web_lock_is_alive() { return 0; }
      finish_web_recovery() { [ "${acknowledged}" = true ]; }
      ${actual}`;
    if (acknowledged) await f.run(body);
    else await assert.rejects(f.run(body), (error) => error.code === 1);
    assert.equal(
      (await readFile(join(f.runner, 'commit-result'), 'utf8')).trim(),
      acknowledged ? 'backup=true committed=true' : 'backup=false committed=false',
    );
  });
