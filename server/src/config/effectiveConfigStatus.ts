import { createHash } from 'node:crypto';

import type { AppConfig } from '../app/config.js';
import type { RuntimeEnvironment } from '../release/runtimeIdentity.js';
import { isTtsCapabilityEnabled } from '../integrations/tts/capability.js';

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
  capabilities: Record<string, boolean>;
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

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

function enabled(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return (value as { enabled?: unknown }).enabled !== false;
}

export function capabilitySnapshot(config: AppConfig): Record<string, boolean> {
  return {
    models: Boolean(config.models?.groups.length),
    codex: config.codexSubscription?.enabled === true,
    webTools: config.webTools?.enabled === true,
    imageGen: config.imageGenTools?.enabled === true,
    stt: config.stt?.enabled === true,
    tts: isTtsCapabilityEnabled(config.tts),
    memory: config.memory?.enabled === true,
    memoryPolling: config.memory?.polling?.enabled === true,
    memoryConsolidation: config.memory?.consolidation?.enabled === true,
    cron: config.cron?.enabled === true,
    systemMonitor: config.systemMonitor?.enabled === true,
    eventRetention: config.runtimeEventRetention?.enabled === true,
    toolControls: enabled(config.toolControls),
    acs: Boolean(config.tenantRemoteHands?.hands.length),
  };
}

export function buildEffectiveConfigStatus(input: {
  config: AppConfig;
  environment: RuntimeEnvironment;
  processRole: string;
  appliedAt: string;
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
  const capabilities = capabilitySnapshot(input.config);
  return {
    configSchemaVersion: EFFECTIVE_CONFIG_SCHEMA_VERSION,
    effectiveConfigFingerprint: digest(input.config),
    capabilityFingerprint: digest(capabilities),
    secretReadiness,
    environment: input.environment,
    processRole: input.processRole,
    appliedAt: input.appliedAt,
    capabilities,
    secrets,
  };
}
