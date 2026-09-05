#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const ACTIONS = new Set(['deploy', 'keep']);
const RETRY_MODES = new Set(['fresh', 'retry_before_change', 'retry_after_change']);

function requireAction(value, label) {
  if (!ACTIONS.has(value)) throw new Error(`${label} must be deploy or keep`);
  return value;
}

/** 正常发布严格核对 trusted identity；中断恢复允许已切换的私有身份先于最终提交。 */
export function planPromotionConfigIdentityBaseline({ retryMode, apiAction, runtimeWorkerAction }) {
  if (!RETRY_MODES.has(retryMode)) throw new Error(`Unknown promotion retry mode: ${retryMode}`);
  const api = requireAction(apiAction, 'Manifest API action');
  const worker = requireAction(runtimeWorkerAction, 'Manifest Runtime Worker action');
  if (api !== worker) throw new Error('Manifest API and Runtime Worker actions must match');

  if (retryMode !== 'retry_after_change') {
    return {
      reader: 'read-production-state.mjs',
      configIdentityStage: 'steady-state',
    };
  }
  return {
    reader: 'read-live-production-components.mjs',
    configIdentityStage: api === 'deploy' ? 'candidate-readback' : 'steady-state',
  };
}

/** 每次生产写入前均要求已建立配置身份，禁止恢复到首次升级的缺失豁免。 */
export function assertPromotionConfigIdentityWriteGate({ manifest, productionState }) {
  const api = requireAction(manifest?.components?.api?.action, 'Manifest API action');
  const worker = requireAction(
    manifest?.components?.runtimeWorker?.action,
    'Manifest Runtime Worker action',
  );
  if (api !== worker) throw new Error('Manifest API and Runtime Worker actions must match');

  if (productionState?.configIdentity?.status !== 'consistent') {
    throw new Error('Production writes require a consistent ConfigIdentity');
  }
  return { configIdentityConfirmed: true };
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
