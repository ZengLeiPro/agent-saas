import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigrationPlan } from './migration-plan.mjs';
import {
  loadMigrationReviews,
  migrationSourceDigest as digest,
  MIGRATION_REVIEWS_PATH,
} from './migration-reviews.mjs';

const BASELINE = 'a'.repeat(40);
const TARGET = 'b'.repeat(40);
const PATH = 'server/src/data/db/migrations.ts';
const EVIDENCE = 'docs/release/迁移审核.md';
const before = 'export const sql = "CREATE TABLE old(id text)";';
const after = 'export const sql = "CREATE TABLE new(id text)";';
function fixture(classification = 'expand') {
  const review = {
    baselineSha: BASELINE,
    files: [
      {
        path: PATH,
        baselineDigest: digest(before),
        targetDigest: digest(after),
        classification,
        reason: '新增独立表，旧表保留；真实 PG 升级和旧写入已验证。',
      },
    ],
    evidence: [{ path: EVIDENCE, digest: digest('审核证据') }],
  };
  return {
    review,
    baselines: { [PATH]: before },
    targets: { [PATH]: after, [EVIDENCE]: '审核证据' },
  };
}
function withDocument(f) {
  return {
    ...f.targets,
    [MIGRATION_REVIEWS_PATH]: JSON.stringify({ schemaVersion: 1, reviews: [f.review] }),
  };
}
function snapshot(tree) {
  return { repositoryPaths: new Set(Object.keys(tree)), read: (path) => tree[path] };
}
function load(f, baseline = BASELINE) {
  return loadMigrationReviews({
    baseline,
    baselineSnapshot: snapshot(f.baselines),
    targetSnapshot: snapshot(withDocument(f)),
  });
}
function plan(f, extra = {}) {
  const targets = withDocument(f);
  const changedPaths = f.changedPaths ?? [PATH, ...Object.keys(extra)];
  return createMigrationPlan({
    baseline: BASELINE,
    target: TARGET,
    changedPaths,
    execFileSync: (_command, args) => {
      if (args[0] === 'show') {
        const [revision, path] = args[1].split(':');
        const tree = revision === BASELINE ? f.baselines : { ...targets, ...extra };
        if (!(path in tree)) throw new Error(`missing ${path}`);
        return tree[path];
      }
      if (args[0] === 'ls-tree') {
        const revision = args[args.indexOf('--') - 1];
        return Object.keys(revision === BASELINE ? f.baselines : { ...targets, ...extra }).join(
          '\n',
        );
      }
      if (args[0] === 'diff' && args.includes('--name-status'))
        return changedPaths.map((path) => `M\t${path}`).join('\n');
      if (args[0] === 'diff') return `@@ -1 +1 @@\n-${before}\n+${extra[args.at(-1)] ?? after}`;
      throw new Error(`unexpected git ${args}`);
    },
  });
}

test('审核结论只绑定完整生产 SHA 和两端文件摘要', () => {
  const f = fixture();
  assert.equal(load(f).entries.get(PATH).classification, 'expand');
  assert.equal(load(f, 'c'.repeat(40)).entries.size, 0);
  for (const side of ['baselines', 'targets']) {
    const changed = fixture();
    changed[side][PATH] += '\n// changed';
    assert.throws(() => load(changed), /source changed/u);
  }
});

test('证据修改、重复路径、非法分类和缺失摘要均阻断', () => {
  for (const mutate of [
    (f) => {
      f.targets[EVIDENCE] = '更换证据';
    },
    (f) => {
      f.review.files.push(f.review.files[0]);
    },
    (f) => {
      f.review.files[0].classification = 'allow-all';
    },
    (f) => {
      delete f.review.files[0].targetDigest;
    },
    (f) => {
      f.review.files[0].path = '../outside';
    },
    (f) => {
      f.review.evidence = [];
    },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => load(f));
  }
});

test('审核支持新增和删除文件，但两端都不存在不构成证据', () => {
  const added = fixture();
  delete added.baselines[PATH];
  added.review.files[0].baselineDigest = null;
  assert.equal(load(added).entries.size, 1);
  const removed = fixture('no-schema-change');
  delete removed.targets[PATH];
  removed.review.files[0].targetDigest = null;
  assert.equal(load(removed).entries.size, 1);
  delete removed.baselines[PATH];
  removed.review.files[0].baselineDigest = null;
  assert.throws(() => load(removed));
});

test('审核过的 expand 进入计划，contract 仍禁止进入 RC', () => {
  assert.equal(plan(fixture()).ok, true);
  const contract = plan(fixture('contract'));
  assert.equal(contract.ok, false);
  assert.match(contract.blockingReasons.join('\n'), /reviewed contract/u);
  const ordinary = plan(fixture('no-schema-change'));
  assert.equal(ordinary.ok, true);
  assert.equal(ordinary.migrationPlan.phase, 'none');
});

test('未审核的新迁移和审核后变更不能借同批记录放行', () => {
  const unknown = plan(fixture(), {
    'server/src/data/other/migrations.ts': 'const sql = "DROP TABLE old";',
  });
  assert.equal(unknown.ok, false);
  const stale = fixture();
  stale.targets[PATH] += '\nconst sql = "DROP TABLE old";';
  assert.equal(plan(stale).ok, false);
  assert.match(plan(stale).blockingReasons.join('\n'), /review validation failed/u);
});

test('计划摘要包含审核结论与证据摘要', () => {
  const f = fixture();
  const first = plan(f).migrationPlan.planDigest;
  assert.equal(first, plan(f).migrationPlan.planDigest);
  f.review.files[0].reason += ' 补充复核。';
  assert.notEqual(first, plan(f).migrationPlan.planDigest);
});

test('纯查询依赖不再被引用须有精确审核，缺失审核仍阻断', () => {
  const f = fixture('no-schema-change');
  const root = 'server/src/runtime/runStoreSchema.ts';
  const helper = 'server/src/runtime/query.ts';
  delete f.baselines[PATH];
  delete f.targets[PATH];
  f.changedPaths = [root];
  f.baselines[root] =
    "import { query } from './query.js'; export async function initializePgRunStore() { return query(); }";
  f.targets[root] = 'export async function initializePgRunStore() { return 1; }';
  f.baselines[helper] = f.targets[helper] = 'export function query() { return 1; }';
  f.review.files[0].path = root;
  f.review.files[0].baselineDigest = digest(f.baselines[root]);
  f.review.files[0].targetDigest = digest(f.targets[root]);
  assert.match(plan(f).blockingReasons.join('\n'), /no longer reachable/u);
  f.review.files.push({
    path: helper,
    baselineDigest: digest(f.baselines[helper]),
    targetDigest: digest(f.targets[helper]),
    classification: 'no-schema-change',
    reason: '纯查询提取，无初始化 SQL。',
  });
  assert.equal(plan(f).ok, true);
});
