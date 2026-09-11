import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { createMigrationPlan } from './migration-plan.mjs';
import { loadMigrationReviews } from './migration-reviews.mjs';

const baseline = 'cc99440d43cdfcb22795260835614fe53eef8035';
const transport = 'server/src/runtime/httpTransport.ts';
const evidence = 'docs/release/PR636-current-base-migration-review-20260911.md';
const quotaSchema = 'server/src/app/modelQuotaSourceSchema.ts';
const quotaEvidence = 'docs/release/PR641-zhipu-quota-config-review-20260911.md';
const auditedPaths = [transport, quotaSchema];
const evidencePaths = [evidence, quotaEvidence];
const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const target = git('rev-parse', 'HEAD').trim();
const snapshot = (sha, overrides = {}, absent = []) => ({
  repositoryPaths: new Set(
    git('ls-tree', '-r', '--name-only', '-z', sha)
      .split('\0')
      .filter((path) => path && !absent.includes(path)),
  ),
  read: (path) =>
    Object.hasOwn(overrides, path) ? overrides[path] : git('show', `${sha}:${path}`),
});
const baselineSnapshot = snapshot(baseline);

test('HTTP baseline retains exact byte-bound reviews alongside the separately audited Zhipu config', () => {
  const loaded = loadMigrationReviews({
    baseline,
    baselineSnapshot,
    targetSnapshot: snapshot(target),
  });
  // This historical baseline now also precedes PR641. Permit exactly the two
  // independently audited paths, not an arbitrary expansion of the review scope.
  assert.deepEqual([...loaded.entries.keys()].sort(), [...auditedPaths].sort());
  for (const path of auditedPaths) {
    assert.equal(loaded.entries.get(path).classification, 'no-schema-change');
  }
  const result = createMigrationPlan({ baseline, target, changedPaths: auditedPaths });
  assert.equal(result.ok, true, result.blockingReasons.join('\n'));
  // A later, separately reviewed expand migration must not fail because these changes are neutral.
  assert.notEqual(result.migrationPlan.phase, 'contract');
});

test('both reviews reject changed target bytes, baseline bytes and changed or missing evidence', () => {
  for (const path of [...auditedPaths, ...evidencePaths]) {
    assert.throws(
      () =>
        loadMigrationReviews({
          baseline,
          baselineSnapshot,
          targetSnapshot: snapshot(target, {
            [path]: `${git('show', `${target}:${path}`)}\nchanged`,
          }),
        }),
      /requires re-review|evidence changed or is invalid/u,
    );
  }
  for (const path of auditedPaths) {
    if (!baselineSnapshot.repositoryPaths.has(path)) continue;
    assert.throws(
      () =>
        loadMigrationReviews({
          baseline,
          baselineSnapshot: snapshot(baseline, {
            [path]: `${git('show', `${baseline}:${path}`)}\nchanged`,
          }),
          targetSnapshot: snapshot(target),
        }),
      /requires re-review/u,
    );
  }
  for (const path of evidencePaths) {
    assert.throws(
      () =>
        loadMigrationReviews({
          baseline,
          baselineSnapshot,
          targetSnapshot: snapshot(target, {}, [path]),
        }),
      /evidence changed or is invalid/u,
    );
  }
});

test('PR641 current baseline reviews only the Zhipu Zod module without GitHub event metadata', () => {
  const quotaBaseline = '9db36e8861304c9254e545c80a17ccc720595af9';
  const loaded = loadMigrationReviews({
    baseline: quotaBaseline,
    baselineSnapshot: snapshot(quotaBaseline),
    targetSnapshot: snapshot(target),
  });
  assert.deepEqual([...loaded.entries.keys()], [quotaSchema]);
  assert.equal(loaded.entries.get(quotaSchema).classification, 'no-schema-change');
  const result = createMigrationPlan({ baseline: quotaBaseline, target, changedPaths: [quotaSchema] });
  assert.equal(result.ok, true, result.blockingReasons.join('\n'));
  assert.notEqual(result.migrationPlan.phase, 'contract');
});
