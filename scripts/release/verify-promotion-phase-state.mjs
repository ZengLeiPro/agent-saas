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

function deployComponent(expected, manifest, component) {
  if (component === 'acs' && manifest.components.acs.action === 'deploy') {
    expected.acs = {
      gitSha: manifest.components.acs.sourceSha,
      orchestratorArtifactDigest: manifest.components.acs.orchestratorArtifactDigest,
      sandboxImageDigest: manifest.components.acs.sandboxImageDigest,
    };
  }
  if (component === 'app' && manifest.components.api.action === 'deploy') {
    expected.api = {
      gitSha: manifest.components.api.sourceSha,
      artifactDigest: manifest.components.api.artifactDigest,
    };
    expected.runtimeWorker = {
      gitSha: manifest.components.runtimeWorker.sourceSha,
      artifactDigest: manifest.components.runtimeWorker.artifactDigest,
    };
  }
  if (component === 'web' && manifest.components.web.action === 'deploy') {
    expected.web = {
      gitSha: manifest.components.web.sourceSha,
      artifactDigest: manifest.components.web.artifactDigest,
    };
  }
}

const PHASES = ['acs', 'app', 'web'];

function allowedPhaseMatrices(manifest, phase) {
  const phaseIndex = PHASES.indexOf(phase);
  const expected = baselineComponents(manifest);
  for (const predecessor of PHASES.slice(0, phaseIndex)) {
    deployComponent(expected, manifest, predecessor);
  }
  const candidates = [structuredClone(expected)];
  for (const committed of PHASES.slice(phaseIndex)) {
    deployComponent(expected, manifest, committed);
    if (JSON.stringify(expected) !== JSON.stringify(candidates.at(-1))) {
      candidates.push(structuredClone(expected));
    }
  }
  return candidates;
}

function mismatch(expected, actual) {
  for (const [component, identity] of Object.entries(expected)) {
    for (const [field, value] of Object.entries(identity)) {
      const observed = actual?.[component]?.[field];
      if (observed !== value) return { component, field, expected: value, actual: observed };
    }
  }
  return null;
}

export function assertPromotionPhaseState(manifest, productionState, phase) {
  if (!['acs', 'app', 'web'].includes(phase)) throw new Error(`Unknown promotion phase: ${phase}`);
  const candidates = allowedPhaseMatrices(manifest, phase);
  const predecessor = candidates[0];
  for (const candidate of candidates) {
    if (!mismatch(candidate, productionState.components)) return candidate;
  }
  const drift = mismatch(predecessor, productionState.components);
  throw new Error(
    `Production changed after promotion gate: ${drift.component}.${drift.field} expected ${drift.expected}, got ${drift.actual}`,
  );
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
