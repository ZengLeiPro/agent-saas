import { createHash } from 'node:crypto';
import { SHA_PATTERN } from './artifact-lib.mjs';

export const MIGRATION_REVIEWS_PATH = 'config/release-migration-reviews.json';
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const CLASSIFICATIONS = new Set(['no-schema-change', 'expand', 'contract']);

export function migrationSourceDigest(content) {
  return content === null ? null : `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function validPath(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.split('/').some((part) => part === '..' || part === '.' || !part)
  );
}

function sourceDigest(snapshot, path) {
  return snapshot.repositoryPaths.has(path) ? migrationSourceDigest(snapshot.read(path)) : null;
}

function validateReview(review) {
  if (
    !SHA_PATTERN.test(review?.baselineSha ?? '') ||
    !Array.isArray(review.files) ||
    !Array.isArray(review.evidence) ||
    review.evidence.length === 0
  ) {
    throw new Error(
      'Migration review requires a baseline, file inventory and verification evidence',
    );
  }
  const entries = new Map();
  for (const entry of review.files) {
    if (
      !validPath(entry.path) ||
      entries.has(entry.path) ||
      !CLASSIFICATIONS.has(entry.classification) ||
      typeof entry.reason !== 'string' ||
      !entry.reason.trim() ||
      ![entry.baselineDigest, entry.targetDigest].every(
        (value) => value === null || DIGEST_PATTERN.test(value),
      ) ||
      (entry.baselineDigest === null && entry.targetDigest === null)
    ) {
      throw new Error(`Invalid or duplicate migration review entry: ${entry.path}`);
    }
    entries.set(entry.path, entry);
  }
  const evidencePaths = new Set();
  for (const evidence of review.evidence) {
    if (
      !validPath(evidence.path) ||
      evidencePaths.has(evidence.path) ||
      !DIGEST_PATTERN.test(evidence.digest)
    ) {
      throw new Error(`Migration review evidence is invalid: ${evidence.path}`);
    }
    evidencePaths.add(evidence.path);
  }
  return entries;
}

function matchesSnapshots(review, entries, baselineSnapshot, targetSnapshot) {
  return (
    [...entries.values()].every(
      (entry) =>
        sourceDigest(baselineSnapshot, entry.path) === entry.baselineDigest &&
        sourceDigest(targetSnapshot, entry.path) === entry.targetDigest,
    ) &&
    review.evidence.every(
      (evidence) => sourceDigest(targetSnapshot, evidence.path) === evidence.digest,
    )
  );
}

function assertMatchesSnapshots(review, entries, baselineSnapshot, targetSnapshot) {
  for (const entry of entries.values()) {
    if (
      sourceDigest(baselineSnapshot, entry.path) !== entry.baselineDigest ||
      sourceDigest(targetSnapshot, entry.path) !== entry.targetDigest
    ) {
      throw new Error(`Migration review source changed and requires re-review: ${entry.path}`);
    }
  }
  for (const evidence of review.evidence) {
    if (sourceDigest(targetSnapshot, evidence.path) !== evidence.digest) {
      throw new Error(`Migration review evidence changed or is invalid: ${evidence.path}`);
    }
  }
}

// 审核记录不替代依赖闭包检查，也不提供通配放行。精确 SHA 记录优先；生产 SHA 因
// 无关提交变化时，仅在全部审核文件的两端内容与证据逐字节相同时复用既有结论。
// 未登记路径仍由 migration-plan 的保守分类器检查，任何内容变化都不会继承审核。
export function loadMigrationReviews({ baseline, baselineSnapshot, targetSnapshot }) {
  const empty = { entries: new Map(), digest: null };
  if (!targetSnapshot.repositoryPaths.has(MIGRATION_REVIEWS_PATH)) return empty;
  const document = JSON.parse(targetSnapshot.read(MIGRATION_REVIEWS_PATH));
  if (document?.schemaVersion !== 1 || !Array.isArray(document.reviews)) {
    throw new Error('Migration review document must use schemaVersion 1 and a reviews array');
  }
  const baselines = new Set();
  const reviews = document.reviews.map((review, index) => {
    const entries = validateReview(review);
    if (baselines.has(review.baselineSha)) {
      throw new Error('Migration review baseline must be unique');
    }
    baselines.add(review.baselineSha);
    return { review, entries, index };
  });
  const exact = reviews.find(({ review }) => review.baselineSha === baseline);
  if (exact) {
    assertMatchesSnapshots(exact.review, exact.entries, baselineSnapshot, targetSnapshot);
    return {
      entries: exact.entries,
      digest: migrationSourceDigest(JSON.stringify(exact.review)),
    };
  }

  const compatible = reviews.filter(({ review, entries }) =>
    matchesSnapshots(review, entries, baselineSnapshot, targetSnapshot),
  );
  if (compatible.length === 0) return empty;

  const classifications = new Map();
  for (const candidate of compatible) {
    for (const [path, entry] of candidate.entries) {
      const existing = classifications.get(path);
      if (existing && existing !== entry.classification) {
        throw new Error(`Content-equivalent migration reviews conflict for: ${path}`);
      }
      classifications.set(path, entry.classification);
    }
  }

  // 选择覆盖文件最少的记录，避免把无关审核权限带入本次计划；同等范围取清单中
  // 最后登记的一条。有效摘要同时绑定实际生产基线，保持发布证据可重放。
  compatible.sort(
    (left, right) => left.entries.size - right.entries.size || right.index - left.index,
  );
  const selected = compatible[0];
  return {
    entries: selected.entries,
    digest: migrationSourceDigest(
      JSON.stringify({ ...selected.review, effectiveBaselineSha: baseline }),
    ),
  };
}
