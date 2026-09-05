#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const ACTIONS = new Set(['deploy', 'keep']);
const RETRY_MODES = new Set(['fresh', 'retry_before_change', 'retry_after_change']);

function requireAction(value, label) {
  if (!ACTIONS.has(value)) throw new Error(`${label} must be deploy or keep`);
  return value;
}

/**
 * ConfigIdentity migration stages are intentionally asymmetric:
 * - fresh/retry_before_change uses the trusted production-state reader and may observe the one
 *   legacy baseline before any write;
 * - retry_after_change normally uses the strict live/private reader;
 * - only a Manifest that deploys both API and Worker may use the legacy retry baseline, because
 *   this run is then guaranteed to execute the API upgrade before convergence is accepted.
 */
export function planPromotionConfigIdentityBaseline({
  retryMode,
  apiAction,
  runtimeWorkerAction,
}) {
  if (!RETRY_MODES.has(retryMode)) throw new Error(`Unknown promotion retry mode: ${retryMode}`);
  const api = requireAction(apiAction, 'Manifest API action');
  const worker = requireAction(runtimeWorkerAction, 'Manifest Runtime Worker action');
  if (api !== worker) throw new Error('Manifest API and Runtime Worker actions must match');

  if (retryMode !== 'retry_after_change') {
    return {
      reader: 'read-production-state.mjs',
      configIdentityStage: 'legacy-pre-upgrade-baseline',
    };
  }
  return {
    reader: 'read-live-production-components.mjs',
    configIdentityStage:
      api === 'deploy' ? 'legacy-api-upgrade-retry-baseline' : 'steady-state',
  };
}

/**
 * A baseline without ConfigIdentity is the legacy first-migration state. It is admissible only
 * when this Manifest deploys API+Worker. Callers must run this before every production write.
 */
export function assertPromotionConfigIdentityWriteGate({ manifest, productionState }) {
  const api = requireAction(manifest?.components?.api?.action, 'Manifest API action');
  const worker = requireAction(
    manifest?.components?.runtimeWorker?.action,
    'Manifest Runtime Worker action',
  );
  if (api !== worker) throw new Error('Manifest API and Runtime Worker actions must match');

  const legacyApiRequiresUpgrade = productionState?.configIdentity === undefined;
  if (legacyApiRequiresUpgrade && api !== 'deploy') {
    throw new Error(
      'Legacy API ConfigIdentity baseline requires this Manifest to deploy API and Runtime Worker before any production write',
    );
  }
  return { legacyApiRequiresUpgrade };
}

function parseOptions(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error('Every option requires a value');
    }
    values[key.slice(2)] = value;
  }
  return values;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const command = process.argv[2];
  const options = parseOptions(process.argv.slice(3));
  let result;
  if (command === 'plan') {
    result = planPromotionConfigIdentityBaseline({
      retryMode: options['retry-mode'],
      apiAction: options['api-action'],
      runtimeWorkerAction: options['runtime-worker-action'],
    });
  } else if (command === 'assert-write-gate') {
    if (!options.manifest || !options['production-state']) {
      throw new Error('assert-write-gate requires --manifest and --production-state');
    }
    result = assertPromotionConfigIdentityWriteGate({
      manifest: JSON.parse(readFileSync(options.manifest, 'utf8')),
      productionState: JSON.parse(readFileSync(options['production-state'], 'utf8')),
    });
  } else {
    throw new Error(`Unknown command: ${command ?? '<missing>'}`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
