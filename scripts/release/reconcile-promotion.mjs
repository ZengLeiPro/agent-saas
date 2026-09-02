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
  if (!receipts || typeof receipts !== 'object' || Array.isArray(receipts)) return null;
  const requiredComponents = ['acs', 'app', 'web'];
  if (
    Object.keys(receipts).sort().join(',') !== requiredComponents.join(',') ||
    requiredComponents.some((component) => {
      const receipt = receipts[component];
      return (
        !receipt ||
        typeof receipt !== 'object' ||
        Array.isArray(receipt) ||
        Object.keys(receipt).sort().join(',') !== 'attempted,succeeded' ||
        typeof receipt.attempted !== 'boolean' ||
        typeof receipt.succeeded !== 'boolean' ||
        (!receipt.attempted && receipt.succeeded)
      );
    })
  )
    return null;
  const attempted = requiredComponents.some((component) => receipts[component].attempted);
  return {
    attempted,
    succeeded:
      attempted &&
      requiredComponents.every(
        (component) => !receipts[component].attempted || receipts[component].succeeded,
      ),
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
  let rollback = { attempted: false, succeeded: false };
  if (input.rollbackReceipts !== undefined) {
    rollback = summarizeRollbackReceipts(input.rollbackReceipts);
    if (!rollback)
      return {
        outcome: 'needs_human',
        reason: 'rollback receipts are incomplete or violate the strict ACS/App/Web schema',
      };
  } else if (input.rollbackAttempted !== undefined || input.rollbackSucceeded !== undefined) {
    return {
      outcome: 'needs_human',
      reason: 'legacy aggregate rollback flags are not authoritative receipts',
    };
  }
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
