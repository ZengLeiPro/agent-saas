import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { loadMigrationReviews, migrationSourceDigest } from './migration-reviews.mjs';

const baseline = 'a7da7be10303c701e4ef49e6f2162d9da7155e13';
const transport = 'server/src/runtime/httpTransport.ts';
const inventoryPath = 'config/release-migration-reviews.json';
const evidencePath = 'docs/release/PR636-HTTP部署排空无结构变更复核-20260911.md';
const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
const review = inventory.reviews.find((entry) => entry.baselineSha === baseline);
const baselineSnapshot = {
  repositoryPaths: new Set(
    execFileSync('git', ['ls-tree', '-r', '--name-only', baseline], { encoding: 'utf8' })
      .trim()
      .split('\n'),
  ),
  read: (path) => execFileSync('git', ['show', `${baseline}:${path}`], { encoding: 'utf8' }),
};
function targetSnapshot(overrides = {}) {
  return {
    repositoryPaths: new Set([
      inventoryPath,
      ...review.files.map((entry) => entry.path),
      ...review.evidence.map((entry) => entry.path),
    ]),
    read: (path) => overrides[path] ?? readFileSync(path, 'utf8'),
  };
}

test('recent JSON-store baseline explicitly reviews the changed HTTP closure dependency', () => {
  const loaded = loadMigrationReviews({
    baseline,
    baselineSnapshot,
    targetSnapshot: targetSnapshot(),
  });
  const entry = loaded.entries.get(transport);
  assert.ok(entry, 'HTTP transport requires an explicit migration review entry');
  assert.equal(entry.classification, 'no-schema-change');
  assert.equal(entry.targetDigest, migrationSourceDigest(readFileSync(transport)));
  assert(review.evidence.some((evidence) => evidence.path === evidencePath));
});

test('HTTP source and audit evidence remain byte-bound rather than path-based exemptions', () => {
  for (const path of [transport, evidencePath]) {
    assert.throws(
      () =>
        loadMigrationReviews({
          baseline,
          baselineSnapshot,
          targetSnapshot: targetSnapshot({ [path]: `${readFileSync(path, 'utf8')}\nchanged` }),
        }),
      /requires re-review|evidence changed or is invalid/u,
    );
  }
});
