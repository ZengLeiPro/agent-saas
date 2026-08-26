import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigrationPlan, isMigrationPath } from './migration-plan.mjs';

const SHA = 'a'.repeat(40);

test('emits a deterministic no-migration plan', () => {
  const first = createMigrationPlan({ changedPaths: ['web/src/App.tsx'], target: SHA });
  const second = createMigrationPlan({ changedPaths: [], target: SHA });
  assert.equal(first.ok, true);
  assert.equal(first.migrationPlan.phase, 'none');
  assert.equal(first.migrationPlan.confirmation, 'not_required');
  assert.equal(first.migrationPlan.planDigest, second.migrationPlan.planDigest);
});

test('binds expand migration content and rejects destructive contract operations', () => {
  const path = 'server/src/data/db/migrations.ts';
  const expand = createMigrationPlan({
    changedPaths: [path],
    target: SHA,
    execFileSync: () => 'CREATE TABLE IF NOT EXISTS safe_addition(id text);',
  });
  assert.equal(expand.ok, true);
  assert.equal(expand.migrationPlan.phase, 'expand');
  assert.equal(expand.migrationPlan.confirmation, 'required_after_observation');
  assert.equal(isMigrationPath(path), true);

  const contract = createMigrationPlan({
    changedPaths: [path],
    target: SHA,
    execFileSync: () => 'ALTER TABLE records DROP COLUMN legacy;',
  });
  assert.equal(contract.ok, false);
  assert.match(contract.blockingReasons[0], /destructive contract operation/u);
});

test('fails closed when a migration file is removed at the target', () => {
  const result = createMigrationPlan({
    changedPaths: ['server/src/context/store/migration.ts'],
    target: SHA,
    execFileSync: () => {
      throw new Error('missing');
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.blockingReasons[0], /separate contract release/u);
});
