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
  if (matrixEquals(observed, target)) {
    if (input.configIdentityConfirmed !== true) {
      return {
        outcome: 'needs_human',
        reason:
          'component convergence lacks complete ConfigIdentity and trusted identity confirmation',
      };
    }
    return {
      outcome: 'completed',
      reason: 'all components match the Manifest target with confirmed ConfigIdentity',
    };
  }
  if (matrixEquals(observed, before)) {
    if (input.rollbackAttempted === true) {
      return {
        outcome: 'rolled_back',
        reason:
          'a dedicated rollback started and all components match the frozen pre-promotion state',
      };
    }
    return {
      outcome: 'failed_before_change',
      reason: 'no rollback started and no production component differs from the frozen baseline',
    };
  }
  if (input.externalSideEffects === 'unknown') {
    return {
      outcome: 'needs_human',
      reason: 'promotion has non-reversible or unknown side effects',
    };
  }
  return {
    outcome: 'partial_failed',
    reason: 'production components contain a mixed identity matrix after reconciliation',
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
