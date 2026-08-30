#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function baselineComponents(manifest) {
  const baseline = manifest.productionBaseline;
  return {
    web: {
      gitSha: baseline.web.sourceSha,
      artifactDigest: baseline.web.artifactDigest,
    },
    api: {
      gitSha: baseline.api.sourceSha,
      artifactDigest: baseline.api.artifactDigest,
    },
    runtimeWorker: {
      gitSha: baseline.runtimeWorker.sourceSha,
      artifactDigest: baseline.runtimeWorker.artifactDigest,
    },
    acs: {
      gitSha: baseline.acs.sourceSha,
      orchestratorArtifactDigest: baseline.acs.orchestratorArtifactDigest,
      sandboxImageDigest: baseline.acs.sandboxImageDigest,
    },
  };
}

export function assertPromotionPhaseState(manifest, productionState, phase) {
  if (!['acs', 'app', 'web'].includes(phase)) throw new Error(`Unknown promotion phase: ${phase}`);
  const expected = baselineComponents(manifest);
  if (['app', 'web'].includes(phase) && manifest.components.acs.action === 'deploy') {
    expected.acs = {
      gitSha: manifest.components.acs.sourceSha,
      orchestratorArtifactDigest: manifest.components.acs.orchestratorArtifactDigest,
      sandboxImageDigest: manifest.components.acs.sandboxImageDigest,
    };
  }
  if (phase === 'web' && manifest.components.api.action === 'deploy') {
    expected.api = {
      gitSha: manifest.components.api.sourceSha,
      artifactDigest: manifest.components.api.artifactDigest,
    };
    expected.runtimeWorker = {
      gitSha: manifest.components.runtimeWorker.sourceSha,
      artifactDigest: manifest.components.runtimeWorker.artifactDigest,
    };
  }
  for (const [component, identity] of Object.entries(expected)) {
    for (const [field, value] of Object.entries(identity)) {
      const actual = productionState.components?.[component]?.[field];
      if (actual !== value) {
        throw new Error(
          `Production changed after promotion gate: ${component}.${field} expected ${value}, got ${actual}`,
        );
      }
    }
  }
  return expected;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [manifestPath, statePath, phase] = process.argv.slice(2);
  if (!manifestPath || !statePath || !phase) {
    throw new Error(
      'usage: verify-promotion-phase-state.mjs <manifest.json> <production-state.json> <acs|app|web>',
    );
  }
  const [manifest, state] = await Promise.all([
    readFile(resolve(manifestPath), 'utf8').then(JSON.parse),
    readFile(resolve(statePath), 'utf8').then(JSON.parse),
  ]);
  assertPromotionPhaseState(manifest, state, phase);
  process.stdout.write(`${phase}\n`);
}
