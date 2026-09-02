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

/**
 * 验证记录相对当前配置的有效性。`never` 与 `passed` 必须能被区分：从未探测过的
 * 能力不能和「刚刚探测通过」显示成同一件事。
 */
export type CapabilityVerification = 'passed' | 'failed' | 'stale' | 'never';

export interface CapabilityReadiness {
  state: CapabilityState;
  /** 相对当前配置切片指纹的验证有效性；lastValidation 是它的原始依据。 */
  verification: CapabilityVerification;
  missing: string[];
  blockers: CapabilityBlocker[];
  lastValidation?: CapabilityValidationRecord;
  targetRouteId: string | null;
}

export function resolveCapabilityVerification(
  lastValidation: CapabilityValidationRecord | undefined,
  configFingerprint: string,
): CapabilityVerification {
  if (!lastValidation) return 'never';
  if (lastValidation.configFingerprint !== configFingerprint) return 'stale';
  return lastValidation.status;
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
 *
 * 已启用的能力只要验证记录失败或过期就落到 `degraded`：绕过向导直接改
 * config.json 会让能力切片指纹变化、验证记录随之过期，必须重新验证而不是
 * 继续显示运行正常。从未验证过（`never`）不等于探测异常，仍按 `enabled`
 * 呈现，但 `verification` 字段会把「未验证」如实带给调用方。
 */
export function resolveCapabilityState(input: {
  enabled: boolean;
  missing: readonly string[];
  blockers: readonly CapabilityBlocker[];
  validating: boolean;
  verification: CapabilityVerification;
}): CapabilityState {
  if (input.blockers.length > 0) return 'blocked';
  if (input.validating) return 'validating';
  if (input.enabled) {
    if (input.missing.length > 0) return 'degraded';
    return input.verification === 'failed' || input.verification === 'stale'
      ? 'degraded'
      : 'enabled';
  }
  if (input.missing.length > 0) return 'incomplete';
  return input.verification === 'passed' ? 'ready' : 'disabled';
}
