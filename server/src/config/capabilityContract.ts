import type { AppConfig } from '../app/config.js';

import { configFingerprint } from './configDigest.js';

/**
 * 能力引导式启用的公共契约（docs/plans/capability-guided-enablement.md §6）。
 *
 * 状态页、能力向导和后端验证器共用这里的 id、状态机与目标路由；本文件不含
 * 任何能力专属字段规则，避免退化成「一套通用必填规则」。
 */

export const CAPABILITY_STATES = [
  'disabled',
  'incomplete',
  'validating',
  'ready',
  'enabled',
  'degraded',
  'blocked',
] as const;
export type CapabilityState = (typeof CAPABILITY_STATES)[number];

export const CAPABILITY_IDS = [
  'models',
  'codex',
  'webTools',
  'imageGen',
  'stt',
  'tts',
  'memory',
  'memoryPolling',
  'memoryConsolidation',
  'cron',
  'systemMonitor',
  'eventRetention',
  'toolControls',
  'acs',
] as const;
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

/** 阻塞原因码。与启用事务的错误码分开：这里描述稳态，不描述一次写入的失败。 */
export const CAPABILITY_BLOCKER_CODES = {
  dependencyDisabled: 'CAPABILITY_DEPENDENCY_DISABLED',
  runtimeStoreUnsupported: 'CAPABILITY_RUNTIME_STORE_UNSUPPORTED',
  invalidParameterCombination: 'CAPABILITY_INVALID_PARAMETER_COMBINATION',
} as const;

export interface CapabilityBlocker {
  code: string;
  message: string;
  targetRouteId?: string;
}

export interface CapabilityValidationRecord {
  status: 'passed' | 'failed';
  validatedAt: string;
  /** 验证当时的能力配置切片指纹；与当前切片不一致说明这条记录已经过期。 */
  configFingerprint: string;
}

export interface CapabilityReadiness {
  state: CapabilityState;
  missing: string[];
  blockers: CapabilityBlocker[];
  lastValidation?: CapabilityValidationRecord;
  targetRouteId: string | null;
}

/**
 * 能力对应的业务配置页。状态页只负责把管理员送到正确的页面并带上能力参数，
 * 具体表单由各能力自己的向导实现。TTS 目前没有独立后台入口，保持 null。
 */
export const CAPABILITY_TARGET_ROUTES: Readonly<Record<CapabilityId, string | null>> = {
  models: 'platform.resource-center.models',
  codex: 'platform.resource-center.models',
  webTools: 'platform.resource-center.tools',
  imageGen: 'platform.resource-center.tools',
  stt: 'platform.resource-center.tools',
  tts: null,
  memory: 'platform.governance.memory-policy',
  memoryPolling: 'platform.governance.memory-policy',
  memoryConsolidation: 'platform.governance.memory-policy',
  cron: 'platform.governance.system-settings',
  systemMonitor: 'platform.governance.system-settings',
  eventRetention: 'platform.governance.system-settings',
  toolControls: 'platform.resource-center.tools',
  acs: 'platform.runtime.execution-providers',
};

/**
 * 能力自己的配置切片。验证记录按切片指纹判定是否过期，这样改动别的能力
 * 不会把本能力刚通过的验证一并作废。
 */
export function capabilityConfigSlice(config: AppConfig, capability: CapabilityId): unknown {
  switch (capability) {
    case 'models':
      return config.models;
    case 'codex':
      return config.codexSubscription;
    case 'webTools':
      return config.webTools;
    case 'imageGen':
      return config.imageGenTools;
    case 'stt':
      return config.stt;
    case 'tts':
      return config.tts;
    case 'memory':
      return config.memory;
    case 'memoryPolling':
      return config.memory?.polling;
    case 'memoryConsolidation':
      return config.memory?.consolidation;
    case 'cron':
      return config.cron;
    case 'systemMonitor':
      return config.systemMonitor;
    case 'eventRetention':
      return config.runtimeEventRetention;
    case 'toolControls':
      return config.toolControls;
    case 'acs':
      return config.tenantRemoteHands;
    default:
      return undefined;
  }
}

export function capabilityConfigFingerprint(config: AppConfig, capability: CapabilityId): string {
  return configFingerprint(capabilityConfigSlice(config, capability) ?? null);
}

/**
 * 状态机。`blocked` 优先于一切：基础设施或依赖不满足时，先解阻塞再谈配置。
 * 验证记录只有在指纹仍然匹配时才算数——配置改过就必须重新验证。
 */
export function resolveCapabilityState(input: {
  enabled: boolean;
  missing: readonly string[];
  blockers: readonly CapabilityBlocker[];
  validating: boolean;
  configFingerprint: string;
  lastValidation?: CapabilityValidationRecord;
}): CapabilityState {
  if (input.blockers.length > 0) return 'blocked';
  if (input.validating) return 'validating';
  const current =
    input.lastValidation?.configFingerprint === input.configFingerprint
      ? input.lastValidation
      : undefined;
  if (input.enabled) {
    return input.missing.length > 0 || current?.status === 'failed' ? 'degraded' : 'enabled';
  }
  if (input.missing.length > 0) return 'incomplete';
  return current?.status === 'passed' ? 'ready' : 'disabled';
}
