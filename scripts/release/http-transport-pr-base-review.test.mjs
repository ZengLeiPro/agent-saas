import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { createMigrationPlan } from './migration-plan.mjs';
import { loadMigrationReviews } from './migration-reviews.mjs';

const baseline = 'cc99440d43cdfcb22795260835614fe53eef8035';
const transport = 'server/src/runtime/httpTransport.ts';
const evidence = 'docs/release/PR636-current-base-migration-review-20260911.md';
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

test('current PR baseline has a single-path byte-bound review even without GitHub events', () => {
  const loaded = loadMigrationReviews({
    baseline,
    baselineSnapshot,
    targetSnapshot: snapshot(target),
  });
  assert.deepEqual([...loaded.entries.keys()], [transport]);
  assert.equal(loaded.entries.get(transport).classification, 'no-schema-change');
  const result = createMigrationPlan({ baseline, target, changedPaths: [transport] });
  assert.equal(result.ok, true, result.blockingReasons.join('\n'));
  // A later, separately reviewed expand migration must not fail just because this HTTP change is neutral.
  assert.notEqual(result.migrationPlan.phase, 'contract');
});

test('the current PR review rejects changes to either source, changed evidence and missing evidence', () => {
  for (const path of [transport, evidence]) {
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
  assert.throws(
    () =>
      loadMigrationReviews({
        baseline,
        baselineSnapshot: snapshot(baseline, {
          [transport]: `${git('show', `${baseline}:${transport}`)}\nchanged`,
        }),
        targetSnapshot: snapshot(target),
      }),
    /requires re-review/u,
  );
  assert.throws(
    () =>
      loadMigrationReviews({
        baseline,
        baselineSnapshot,
        targetSnapshot: snapshot(target, {}, [evidence]),
      }),
    /evidence changed or is invalid/u,
  );
});
