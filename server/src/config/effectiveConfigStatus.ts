import type { AppConfig } from '../app/config.js';
import type { RuntimeEnvironment } from '../release/runtimeIdentity.js';

import type { CapabilityId, CapabilityReadiness } from './capabilityContract.js';
import {
  buildCapabilityStatus,
  capabilitySnapshot,
  type CapabilityValidationLookup,
} from './capabilityReadiness.js';
import { configFingerprint } from './configDigest.js';

export { capabilitySnapshot };

export const EFFECTIVE_CONFIG_SCHEMA_VERSION = 1;

export type EffectiveConfigTarget = 'models' | 'tools' | 'memory' | 'system' | 'execution';

export interface EffectiveConfigSecretItem {
  path: string;
  status: 'reference' | 'legacy_inline' | 'missing';
  target: EffectiveConfigTarget | null;
}

export interface EffectiveConfigStatus {
  configSchemaVersion: number;
  effectiveConfigFingerprint: string;
  capabilityFingerprint: string;
  secretReadiness: 'ready' | 'missing' | 'legacy_inline' | 'unknown';
  environment: RuntimeEnvironment;
  processRole: string;
  appliedAt: string;
  /** 兼容字段：只回答「是否已启用」。新调用方请读 capabilityStates。 */
  capabilities: Record<string, boolean>;
  /** 逐能力的就绪状态、缺失字段、阻塞项与最近一次验证结果。 */
  capabilityStates: Record<CapabilityId, CapabilityReadiness>;
  secrets: {
    references: number;
    inlineLegacy: number;
    missing: number;
    items: EffectiveConfigSecretItem[];
  };
}

const SECRET_KEY =
  /(secret|password|token|api[-_]?key|private[-_]?key|authorization|credential)$/iu;
const SECRET_REF_KEY = /(secret|token|api[-_]?key|private[-_]?key|credential).*(ref|id)$/iu;
const SAFE_SECRET_METADATA = new Set([
  'tokenExpiresIn',
  'maxOutputTokens',
  'maxTokens',
  'tokenBudget',
  'credentialCount',
]);

function targetForSecret(path: string): EffectiveConfigTarget | null {
  if (path.startsWith('models.') || path.startsWith('codexSubscription.')) return 'models';
  if (
    path.startsWith('webTools.') ||
    path.startsWith('imageGenTools.') ||
    path.startsWith('stt.') ||
    path.startsWith('toolControls.')
  )
    return 'tools';
  if (path.startsWith('memory.')) return 'memory';
  if (path.startsWith('tenantRemoteHands.')) return 'execution';
  if (
    path.startsWith('cron.') ||
    path.startsWith('systemMonitor.') ||
    path.startsWith('runtimeEventRetention.')
  )
    return 'system';
  return null;
}

function secretSummary(value: unknown): EffectiveConfigStatus['secrets'] {
  const summary: EffectiveConfigStatus['secrets'] = {
    references: 0,
    inlineLegacy: 0,
    missing: 0,
    items: [],
  };
  const addItem = (path: string, status: EffectiveConfigSecretItem['status']): void => {
    summary.items.push({ path, status, target: targetForSecret(path) });
  };
  const visit = (current: unknown, parentPath = ''): void => {
    if (Array.isArray(current)) {
      current.forEach((child, index) => visit(child, `${parentPath}[${index}]`));
      return;
    }
    if (!current || typeof current !== 'object') return;
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      const path = parentPath ? `${parentPath}.${key}` : key;
      if (!SAFE_SECRET_METADATA.has(key) && SECRET_REF_KEY.test(key)) {
        if (child === undefined || child === null || child === '') {
          summary.missing++;
          addItem(path, 'missing');
        } else {
          summary.references++;
          addItem(path, 'reference');
        }
      } else if (!SAFE_SECRET_METADATA.has(key) && SECRET_KEY.test(key)) {
        if (child === undefined || child === null || child === '') {
          summary.missing++;
          addItem(path, 'missing');
        } else {
          summary.inlineLegacy++;
          addItem(path, 'legacy_inline');
        }
      } else {
        visit(child, path);
      }
    }
  };
  visit(value);
  summary.items.sort((left, right) => left.path.localeCompare(right.path));
  return summary;
}

export function buildEffectiveConfigStatus(input: {
  config: AppConfig;
  environment: RuntimeEnvironment;
  processRole: string;
  appliedAt: string;
  validations?: CapabilityValidationLookup;
}): EffectiveConfigStatus {
  const secrets = secretSummary(input.config);
  const secretReadiness =
    secrets.missing > 0
      ? 'missing'
      : secrets.inlineLegacy > 0
        ? 'legacy_inline'
        : secrets.references > 0
          ? 'ready'
          : 'unknown';
  const { capabilities, capabilityStates } = buildCapabilityStatus({
    config: input.config,
    ...(input.validations ? { validations: input.validations } : {}),
  });
  return {
    configSchemaVersion: EFFECTIVE_CONFIG_SCHEMA_VERSION,
    effectiveConfigFingerprint: configFingerprint(input.config),
    capabilityFingerprint: configFingerprint(capabilities),
    secretReadiness,
    environment: input.environment,
    processRole: input.processRole,
    appliedAt: input.appliedAt,
    capabilities,
    capabilityStates,
    secrets,
  };
}
