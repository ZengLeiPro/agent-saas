import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateProductionOperation } from './production-operation.mjs';

const context = { eventName: 'workflow_dispatch', ref: 'refs/heads/main' };
const rc = { release_id: 'rc-20260910-01', reason: 'Approved immutable RC' };
const digest = `sha256:${'a'.repeat(64)}`;
const repair = {
  operation: 'web-recovery-repair',
  expected_plan_digest: digest,
  confirm_recovery_only: true,
  reason: 'Reviewed cold-standby audit',
};
const audit = { operation: 'web-recovery-audit', reason: 'Inspect cold standby' };
const validate = (inputs) => validateProductionOperation(inputs, context);

test('existing callers default to RC promotion; RC repair is not Web cold-standby repair', () => {
  assert.deepEqual(validate(rc), { operation: 'promote', recoveryMode: '' });
  assert.deepEqual(validate({ ...rc, recovery_mode: 'repair' }), {
    operation: 'promote',
    recoveryMode: '',
  });
  assert.deepEqual(validate(audit), { operation: 'web-recovery-audit', recoveryMode: 'audit' });
  assert.deepEqual(validate(repair), { operation: 'web-recovery-repair', recoveryMode: 'repair' });
  assert.deepEqual(validate({ ...repair, confirm_recovery_only: 'true' }), validate(repair));
});

for (const inputs of [
  { ...rc, operation: '' },
  { ...rc, operation: 'force' },
  { ...rc, operation: 'promote\nrecovery_mode=repair' },
  { ...rc, release_id: '' },
  { ...rc, release_id: 'main' },
  { ...rc, release_id: 'rc-20260910-01\nextra=1' },
  { ...rc, reason: '   ' },
  { ...rc, reason: {} },
  { ...rc, recovery_mode: 'force' },
  { ...rc, expected_plan_digest: digest },
  { ...rc, confirm_recovery_only: true },
  { ...repair, release_id: rc.release_id },
  { ...repair, recovery_mode: 'repair' },
  { ...repair, confirm_recovery_only: false },
  { ...repair, confirm_recovery_only: 'false' },
  { ...repair, confirm_recovery_only: 1 },
  { ...repair, expected_plan_digest: '' },
  { ...repair, expected_plan_digest: 'sha256:abcd' },
  { ...repair, expected_plan_digest: `${digest}\nforged=1` },
  { ...audit, confirm_recovery_only: true },
  { ...audit, expected_plan_digest: digest },
  { ...audit, release_id: rc.release_id },
  { ...audit, recovery_mode: 'repair' },
  null,
  [],
]) {
  test(`refuses invalid or mixed operation inputs: ${JSON.stringify(inputs)}`, () => {
    assert.throws(() => validate(inputs));
  });
}

test('push/PR/tag/non-main dispatch cannot select any production operation', () => {
  for (const eventName of ['push', 'pull_request', 'pull_request_target', 'repository_dispatch']) {
    assert.throws(() => validateProductionOperation(repair, { ...context, eventName }));
  }
  for (const ref of ['refs/heads/feature', 'refs/tags/main', '', 'main']) {
    assert.throws(() => validateProductionOperation(repair, { ...context, ref }));
  }
});

test('CLI writes only validated enumerated outputs and never reports success for invalid inputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'production-operation-'));
  try {
    const event = join(root, 'event.json');
    const output = join(root, 'output');
    const run = (inputs) => {
      writeFileSync(event, JSON.stringify({ inputs }));
      writeFileSync(output, '');
      return spawnSync(
        process.execPath,
        [new URL('./production-operation.mjs', import.meta.url).pathname],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            GITHUB_EVENT_NAME: context.eventName,
            GITHUB_REF: context.ref,
            GITHUB_EVENT_PATH: event,
            GITHUB_OUTPUT: output,
          },
        },
      );
    };
    assert.equal(run(repair).status, 0);
    assert.equal(
      readFileSync(output, 'utf8'),
      'operation=web-recovery-repair\nrecovery_mode=repair\n',
    );
    assert.notEqual(run({ ...repair, confirm_recovery_only: false }).status, 0);
    assert.equal(readFileSync(output, 'utf8'), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
