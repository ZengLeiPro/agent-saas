#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { canonicalJson } from './artifact-lib.mjs';

export const PROMOTION_OUTCOMES = Object.freeze([
  'completed',
  'failed_before_change',
  'partial_failed',
  'rolled_back',
  'needs_human',
]);

function matrixEquals(left, right) {
  return canonicalJson(left ?? null) === canonicalJson(right ?? null);
}

export function componentIdentityMatrix(components) {
  if (!components || typeof components !== 'object') return null;
  const { web, api, runtimeWorker, acs } = components;
  if (!web || !api || !runtimeWorker || !acs) return null;
  return {
    web: { gitSha: web.gitSha, artifactDigest: web.artifactDigest },
    api: { gitSha: api.gitSha, artifactDigest: api.artifactDigest },
    runtimeWorker: {
      gitSha: runtimeWorker.gitSha,
      artifactDigest: runtimeWorker.artifactDigest,
    },
    acs: {
      gitSha: acs.gitSha,
      orchestratorArtifactDigest: acs.orchestratorArtifactDigest,
      sandboxImageDigest: acs.sandboxImageDigest,
    },
  };
}

export function summarizeRollbackReceipts(receipts) {
  if (!receipts || typeof receipts !== 'object') return null;
  const entries = Object.values(receipts);
  if (entries.length === 0) return { attempted: false, succeeded: false };
  const attempted = entries.some((entry) => entry?.attempted === true);
  return {
    attempted,
    succeeded:
      attempted && entries.every((entry) => entry?.attempted !== true || entry?.succeeded === true),
  };
}

export function reconcilePromotion(input) {
  if (!input?.releaseId || !input.before || !input.target)
    throw new Error('Promotion reconciliation requires release, before and target identities');
  if (input.observationComplete !== true || !input.observed) {
    return {
      outcome: 'needs_human',
      reason: 'authoritative post-change observation is incomplete',
    };
  }
  const before = componentIdentityMatrix(input.before);
  const target = componentIdentityMatrix(input.target);
  const observed = componentIdentityMatrix(input.observed);
  if (!before || !target || !observed)
    return { outcome: 'needs_human', reason: 'component identity matrix is incomplete' };
  if (input.databaseChange === 'contract_started') {
    return {
      outcome: 'needs_human',
      reason: 'promotion started a forbidden destructive contract migration',
    };
  }
  const rollback = summarizeRollbackReceipts(input.rollbackReceipts) ?? {
    attempted: input.rollbackAttempted === true,
    succeeded: input.rollbackSucceeded === true,
  };
  if (rollback.attempted) {
    if (!rollback.succeeded)
      return {
        outcome: 'needs_human',
        reason: 'rollback was attempted but one or more component restorations were not verified',
      };
    if (matrixEquals(observed, before))
      return {
        outcome: 'rolled_back',
        reason: 'all components and restored entry bytes match the frozen pre-promotion state',
      };
    return {
      outcome: 'needs_human',
      reason:
        'rollback receipts claim success but the authoritative component matrix is not restored',
    };
  }
  if (matrixEquals(observed, target)) {
    return { outcome: 'completed', reason: 'all components match the Manifest target' };
  }
  if (input.externalSideEffects === 'unknown') {
    return {
      outcome: 'needs_human',
      reason: 'promotion has non-reversible or unknown side effects',
    };
  }
  if (matrixEquals(observed, before)) {
    return {
      outcome: 'failed_before_change',
      reason: 'no production component changed before the failure',
    };
  }
  return {
    outcome: 'partial_failed',
    reason: 'production components contain a mixed or unverified identity matrix',
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [inputPath, outputPath] = process.argv.slice(2);
  if (!inputPath) throw new Error('usage: reconcile-promotion.mjs <input.json> [output.json]');
  const input = JSON.parse(await readFile(inputPath, 'utf8'));
  const result = { releaseId: input.releaseId, ...reconcilePromotion(input) };
  if (outputPath)
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
