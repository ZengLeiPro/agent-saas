import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { collectDiagnostics } from './collect-promotion-diagnostics.mjs';
import {
  baselineProvenance,
  safePreflightSummary,
  safePrechangeFailure,
} from './production-preflight-report.mjs';

const context = { runId: '123', runAttempt: '2' };
const proof = {
  schemaVersion: 1,
  ...context,
  phase: 'before_production_mutation',
  scope: 'current_attempt_only',
  outcome: 'failed_before_change',
  priorRecoveryRequired: false,
};
const preflight = {
  schemaVersion: 1,
  ...context,
  phase: 'before_production_mutation',
  scope: 'current_attempt_only',
  status: 'failed',
  reader: 'read-production-state.mjs',
  attempts: [
    {
      exitCode: 1,
      observation: {
        retry: { reasonCode: 'worker_readyfile_io_error' },
        runtimeWorker: {
          mainPid: 101,
          readyfile: { errno: 'EACCES', pid: null },
          secret: 'NEVER_EXPORT',
        },
      },
    },
  ],
  secret: 'NEVER_EXPORT',
};
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-evidence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    put: (name, value) =>
      writeFileSync(join(dir, name), `${JSON.stringify(value)}\n`, { mode: 0o600 }),
  };
}

test('preflight error is retained even when no complete production state or reconciliation exists', async (t) => {
  const f = setup(t);
  f.put('production-preflight.json', preflight);
  const summary = await collectDiagnostics(f.dir, join(f.dir, 'out'), context);
  assert.equal(summary.outcome, 'failed_before_change');
  assert.equal(summary.preflight.readyfileErrno, 'EACCES');
  assert.equal(summary.preflight.mainPid, 101);
  assert.equal(summary.evidencePresent['production-before.json'], false);
  assert.doesNotMatch(JSON.stringify(summary), /NEVER_EXPORT/u);
});
test('explicit prechange marker covers transport and other failures before reader startup', async (t) => {
  const f = setup(t);
  f.put('promotion-prechange-failure.json', proof);
  const summary = await collectDiagnostics(f.dir, join(f.dir, 'out'), context);
  assert.equal(summary.outcome, 'failed_before_change');
  assert.equal(summary.preflight, null);
  assert.equal(summary.prechangeFailure.scope, 'current_attempt_only');
});
test('absence of receipts alone is never used as proof production was unchanged', async (t) => {
  const f = setup(t);
  assert.equal((await collectDiagnostics(f.dir, join(f.dir, 'out'), context)).outcome, 'unknown');
});
for (const mismatch of [
  { runId: '122' },
  { runAttempt: '1' },
  { scope: 'all_history' },
  { phase: 'after_production_mutation' },
]) {
  test(`rejects stale or wrong-scope evidence ${JSON.stringify(mismatch)}`, async (t) => {
    const f = setup(t);
    f.put('promotion-prechange-failure.json', { ...proof, ...mismatch });
    f.put('production-preflight.json', { ...preflight, ...mismatch });
    assert.equal((await collectDiagnostics(f.dir, join(f.dir, 'out'), context)).outcome, 'unknown');
  });
}
test('post-mutation reconciliation takes precedence over a preflight record', async (t) => {
  const f = setup(t);
  f.put('production-preflight.json', preflight);
  f.put('reconcile.json', { outcome: 'needs_human' });
  assert.equal(
    (await collectDiagnostics(f.dir, join(f.dir, 'out'), context)).outcome,
    'needs_human',
  );
});
test('retry-after-change failures retain the prior recovery requirement', () => {
  assert.equal(
    safePrechangeFailure({ ...proof, priorRecoveryRequired: true }, context).priorRecoveryRequired,
    true,
  );
  assert.equal(
    safePreflightSummary({ ...preflight, priorRecoveryRequired: true }, context)
      .priorRecoveryRequired,
    true,
  );
});
test('last committed baseline is historical only and never grants promotion authorization', () => {
  assert.deepEqual(baselineProvenance('last_committed', {}), {
    schemaVersion: 1,
    source: 'last_committed',
    historicalBuildBaseline: true,
    productionPreflight: 'failed',
    promotionAuthorized: false,
    observedAt: null,
  });
  assert.equal(baselineProvenance('live', {}).promotionAuthorized, false);
  assert.throws(() => baselineProvenance('ignore_preflight', {}));
});

function transport(t, firstExit, secondExit, invalid = false) {
  const f = setup(t);
  const ssh = join(f.dir, 'ssh');
  writeFileSync(
    ssh,
    `#!/usr/bin/env bash\nset -eu\ncount=0\nif [ -f "$RUNNER_TEMP/calls" ]; then count=$(cat "$RUNNER_TEMP/calls"); fi\ncount=$((count+1))\necho "$count" > "$RUNNER_TEMP/calls"\nprintf '%s\\n' "$*" >> "$RUNNER_TEMP/commands"\nif [ "$count" = 1 ]; then exit ${firstExit}; fi\nprintf '%s\\n' '${JSON.stringify(preflight)}'\nexit ${secondExit}\n`,
    { mode: 0o700 },
  );
  const result = spawnSync(
    'bash',
    [
      resolve('scripts/release/run-production-preflight.sh'),
      '/tmp/release-preflight-123-2',
      '/fake/key',
      invalid ? '../unsafe.mjs' : 'read-production-state.mjs',
      'steady-state',
      'production-before.json',
      'fresh',
    ],
    {
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        PATH: `${f.dir}:${process.env.PATH}`,
        RUNNER_TEMP: f.dir,
        GITHUB_RUN_ID: '123',
        GITHUB_RUN_ATTEMPT: '2',
        ECS_USER: 'test',
        ECS_HOST: 'example.invalid',
      },
    },
  );
  return { ...f, result };
}
test('actual SSH wrapper collects host diagnostics after a reader failure', (t) => {
  const f = transport(t, 17, 0);
  assert.equal(f.result.status, 17, f.result.stderr);
  assert.equal(readFileSync(join(f.dir, 'calls'), 'utf8').trim(), '2');
  assert.equal(
    JSON.parse(readFileSync(join(f.dir, 'production-preflight.json'), 'utf8')).status,
    'failed',
  );
  assert.deepEqual(
    JSON.parse(readFileSync(join(f.dir, 'production-preflight-transfer.json'), 'utf8')),
    { schemaVersion: 1, ...context, readerExitCode: 17, diagnosticsTransferExitCode: 0 },
  );
  const commands = readFileSync(join(f.dir, 'commands'), 'utf8');
  assert.match(commands, /sudo -n node/u);
  assert.match(commands, /sudo -n cat/u);
  assert.doesNotMatch(commands, /chmod|systemctl (?:restart|stop)|touch /u);
});
test('diagnostic transfer failure does not overwrite the original reader exit status', (t) => {
  const f = transport(t, 19, 7);
  assert.equal(f.result.status, 19, f.result.stderr);
  assert.equal(existsSync(join(f.dir, 'production-preflight.json')), false);
  assert.equal(existsSync(join(f.dir, 'production-preflight.json.partial')), false);
  assert.equal(
    JSON.parse(readFileSync(join(f.dir, 'production-preflight-transfer.json')))
      .diagnosticsTransferExitCode,
    7,
  );
});
test('successful reader remains successful even if diagnostic transfer fails', (t) => {
  const f = transport(t, 0, 7);
  assert.equal(f.result.status, 0, f.result.stderr);
});
test('invalid reader is rejected before any SSH command', (t) => {
  const f = transport(t, 0, 0, true);
  assert.notEqual(f.result.status, 0);
  assert.equal(existsSync(join(f.dir, 'calls')), false);
});
test('both workflows transport the complete preflight payload and archive failures before the mutation path', () => {
  const production = readFileSync('.github/workflows/promote-release.yml', 'utf8');
  const staging = readFileSync('.github/workflows/deploy-staging.yml', 'utf8');
  for (const workflow of [production, staging]) {
    for (const file of [
      'production-preflight.mjs',
      'production-runtime-observation.mjs',
      'production-preflight-report.mjs',
      'run-production-preflight.sh',
    ])
      assert.ok(workflow.includes(file), file);
    assert.ok(workflow.includes('production-preflight*.json'));
  }
  assert.ok(production.includes('promotion-prechange-failure.json'));
  assert.ok(staging.includes('production-baseline-provenance.json'));
  assert.ok(staging.includes('historical build baseline only'));
  assert.ok(
    production.indexOf('bash scripts/release/run-production-preflight.sh') <
      production.indexOf('assert-write-gate'),
  );
});
