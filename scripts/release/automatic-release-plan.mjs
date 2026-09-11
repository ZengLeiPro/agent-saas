import assert from 'node:assert/strict';
import { assertCheckpointManifest } from './production-checkpoint.mjs';
import { assertPromotionRetryable } from './assert-promotion-retry.mjs';
import {
  hash,
  normalizedComponents,
  requireAutomatic,
  seal,
} from './automatic-release-contract.mjs';

const terminal = new Set(['completed', 'rolled_back', 'rejected', 'revoked']);
const candidateStates = new Set([
  'verified',
  'approved',
  'failed_before_change',
  'needs_human',
  'promoting',
  'awaiting_expand_confirmation',
  'completed',
]);

export function describeRelease({ manifest, history }, now = Date.now()) {
  assertCheckpointManifest(manifest);
  assert(Array.isArray(history) && history.length > 0, 'Missing release history');
  let time = 0;
  const operations = new Set();
  for (const entry of history) {
    assert.equal(entry.releaseId, manifest.releaseId);
    assert.equal(entry.manifestDigest, manifest.digest);
    const at = Date.parse(entry.recordedAt);
    assert(Number.isFinite(at) && at >= time && at <= now + 60000, 'Invalid history order');
    assert(entry.operationKey && !operations.has(entry.operationKey), 'Duplicate operation');
    operations.add(entry.operationKey);
    time = at;
  }
  const last = history.at(-1);
  const verified = history.findLast((entry) => entry.state === 'verified');
  const mutation = history.findLast((entry) => entry.state === 'promoting');
  const completion = history.findLast((entry) => entry.state === 'completed');
  return {
    manifest,
    history,
    state: last.state,
    verifiedAt: verified ? Date.parse(verified.recordedAt) : null,
    mutationAt: mutation ? Date.parse(mutation.recordedAt) : null,
    completedAt: completion ? Date.parse(completion.recordedAt) : null,
    lastAt: Date.parse(last.recordedAt),
  };
}

/** Selection is bounded by the request's original main revision AND click time, not an RC number. */
export function chooseTarget(releases, { engineSha, requestedAt, isAncestor }) {
  const eligible = releases.filter(
    (release) =>
      release.verifiedAt !== null &&
      release.verifiedAt <= requestedAt &&
      candidateStates.has(release.state) &&
      isAncestor(release.manifest.releaseSha, engineSha),
  );
  requireAutomatic(
    eligible.length > 0,
    'no_verified_target',
    '没有可用的已验收版本；请先完成测试环境部署。',
  );
  eligible.sort((a, b) => {
    const left = a.manifest.releaseSha;
    const right = b.manifest.releaseSha;
    if (left === right)
      return (
        a.verifiedAt - b.verifiedAt || a.manifest.releaseId.localeCompare(b.manifest.releaseId)
      );
    if (isAncestor(left, right)) return -1;
    if (isAncestor(right, left)) return 1;
    throw new Error('Accepted source history is not ordered on main');
  });
  return eligible.at(-1);
}

export function createRequest({ run, repository, reason, releases, isAncestor }) {
  const target = chooseTarget(releases, {
    engineSha: run.head_sha,
    requestedAt: Date.parse(run.created_at),
    isAncestor,
  });
  return seal({
    schemaVersion: 1,
    kind: 'automatic-release-request',
    repository,
    parentRunId: String(run.id),
    engineSha: run.head_sha,
    requestedAt: run.created_at,
    reason,
    target: {
      releaseId: target.manifest.releaseId,
      sourceSha: target.manifest.releaseSha,
      manifestDigest: target.manifest.digest,
      verifiedAt: new Date(target.verifiedAt).toISOString(),
    },
  });
}

export function currentTransactions(releases) {
  const completed = releases
    .filter((r) => r.state === 'completed')
    .sort((a, b) => a.completedAt - b.completedAt)
    .at(-1);
  const floor = completed?.completedAt ?? 0;
  // Old unclosed records are historical after a later whole-matrix commit. A later mutation is not.
  const interrupted = releases.filter(
    (r) => r.mutationAt !== null && r.mutationAt > floor && !terminal.has(r.state),
  );
  const unsafe = releases.filter(
    (r) =>
      r.mutationAt !== null && r.mutationAt > floor && ['rejected', 'revoked'].includes(r.state),
  );
  requireAutomatic(
    unsafe.length === 0,
    'revoked_mutation',
    '有发生过生产变更后被撤销的事务，需要核验现场，不能自动重放。',
  );
  requireAutomatic(
    interrupted.length <= 1,
    'ambiguous_transactions',
    '存在多个未闭合的生产事务；自动恢复无法唯一确定现场，已停止。',
  );
  return { completed, recovery: interrupted[0] };
}

export function planRequest(request, releases, { isAncestor, now = Date.now() }) {
  const target = releases.find((r) => r.manifest.releaseId === request.target.releaseId);
  requireAutomatic(
    target &&
      target.manifest.digest === request.target.manifestDigest &&
      target.manifest.releaseSha === request.target.sourceSha,
    'target_changed',
    '本次锁定的目标证据缺失或发生变化，不能改选其他版本。',
  );
  requireAutomatic(
    candidateStates.has(target.state),
    'target_revoked',
    '本次目标已撤销或失效，自动发布已停止。',
  );
  const { completed, recovery } = currentTransactions(releases);
  for (const record of [completed, recovery].filter(Boolean))
    requireAutomatic(
      isAncestor(record.manifest.releaseSha, request.target.sourceSha),
      'would_downgrade',
      '生产已进入比本次目标更新的版本，本次请求不会把它降回旧版。',
    );
  if (recovery) {
    requireAutomatic(
      Date.parse(recovery.manifest.promotionPolicy.expiresAt) > now,
      'recovery_expired',
      '未完成事务的恢复证据已过期，需要受控重新验收；不会猜测旧版本或延长有效期。',
    );
    const history = recovery.history;
    // The existing production worker durably normalizes a dangling promoting marker.
    if (!['promoting', 'awaiting_expand_confirmation'].includes(recovery.state))
      assert.equal(assertPromotionRetryable(history).mode, 'retry_after_change');
  }
  const matchesBaseline =
    completed &&
    hash(normalizedComponents(completed.manifest.components)) ===
      hash(normalizedComponents(target.manifest.productionBaseline));
  return {
    target,
    completed,
    recovery,
    needsRefresh:
      target.state !== 'completed' &&
      (!!recovery ||
        !!target.manifest.baselineObservation ||
        Date.parse(target.manifest.promotionPolicy.expiresAt) <= now ||
        (!!completed && !matchesBaseline)),
  };
}
