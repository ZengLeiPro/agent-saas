import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { loadMigrationReviews } from './migration-reviews.mjs';
const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const target = git('rev-parse', 'HEAD').trim();
const source = 'server/src/app/runtime.ts';
const evidence = 'docs/reviews/grok-runtime-assembly-migration.md';
const snapshot = (sha, overrides = {}, absent = []) => ({
  repositoryPaths: new Set(
    git('ls-tree', '-r', '--name-only', '-z', sha)
      .split('\0')
      .filter((path) => path && !absent.includes(path)),
  ),
  read: (path) =>
    Object.hasOwn(overrides, path) ? overrides[path] : git('show', `${sha}:${path}`),
});
const document = JSON.parse(git('show', `${target}:config/release-migration-reviews.json`));
const hash = (value) => 'sha256:' + createHash('sha256').update(value).digest('hex');
test('Grok re-review retains historical expand decisions and binds runtime source and evidence bytes', () => {
  const reviewed = document.reviews.filter((review) =>
    review.files.some((file) => file.path === source),
  );
  assert.ok(reviewed.length > 0);
  for (const review of reviewed) {
    const entry = review.files.find((file) => file.path === source);
    assert.equal(entry.targetDigest, hash(git('show', `${target}:${source}`)));
    assert.ok(['expand', 'no-schema-change'].includes(entry.classification));
    assert.equal(
      review.evidence.find((item) => item.path === evidence)?.digest,
      hash(git('show', `${target}:${evidence}`)),
    );
  }
  assert.ok(
    reviewed.some((review) =>
      review.files.some((file) => file.path === source && file.classification === 'expand'),
    ),
  );
});
test('changed runtime bytes or missing new evidence still invalidate the whole historical review', () => {
  const baseline = document.reviews.find((review) =>
    review.files.some((file) => file.path === source),
  ).baselineSha;
  const baselineSnapshot = snapshot(baseline);
  assert.throws(
    () =>
      loadMigrationReviews({
        baseline,
        baselineSnapshot,
        targetSnapshot: snapshot(target, {
          [source]: git('show', `${target}:${source}`) + '\nchanged',
        }),
      }),
    /source changed and requires re-review/u,
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
