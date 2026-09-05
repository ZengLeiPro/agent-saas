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

// 审核记录不替代依赖闭包检查，也不提供通配放行。每条结论只适用于指定生产基线和
// 两端完全相同的文件内容；源码、验证用例或审核说明变化后必须重新审核。
export function loadMigrationReviews({ baseline, baselineSnapshot, targetSnapshot }) {
  const empty = { entries: new Map(), digest: null };
  if (!targetSnapshot.repositoryPaths.has(MIGRATION_REVIEWS_PATH)) return empty;
  const document = JSON.parse(targetSnapshot.read(MIGRATION_REVIEWS_PATH));
  if (document?.schemaVersion !== 1 || !Array.isArray(document.reviews)) {
    throw new Error('Migration review document must use schemaVersion 1 and a reviews array');
  }
  const matches = document.reviews.filter((review) => review.baselineSha === baseline);
  if (matches.length === 0) return empty;
  if (matches.length !== 1) throw new Error('Migration review baseline must be unique');
  const review = matches[0];
  if (
    !SHA_PATTERN.test(review.baselineSha) ||
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
    if (
      sourceDigest(baselineSnapshot, entry.path) !== entry.baselineDigest ||
      sourceDigest(targetSnapshot, entry.path) !== entry.targetDigest
    ) {
      throw new Error(`Migration review source changed and requires re-review: ${entry.path}`);
    }
    entries.set(entry.path, entry);
  }
  const evidencePaths = new Set();
  for (const evidence of review.evidence) {
    if (
      !validPath(evidence.path) ||
      evidencePaths.has(evidence.path) ||
      !DIGEST_PATTERN.test(evidence.digest) ||
      sourceDigest(targetSnapshot, evidence.path) !== evidence.digest
    ) {
      throw new Error(`Migration review evidence changed or is invalid: ${evidence.path}`);
    }
    evidencePaths.add(evidence.path);
  }
  return { entries, digest: migrationSourceDigest(JSON.stringify(review)) };
}
