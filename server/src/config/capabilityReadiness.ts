import type { AppConfig } from '../app/config.js';

import {
  CAPABILITY_IDS,
  CAPABILITY_TARGET_ROUTES,
  capabilityConfigFingerprint,
  resolveCapabilityState,
  type CapabilityId,
  type CapabilityReadiness,
  type CapabilityValidationRecord,
} from './capabilityContract.js';
import {
  CAPABILITY_EVALUATORS,
  DEPENDENT_CAPABILITY_IDS,
  type CapabilityDraft,
  type CapabilityEvaluationContext,
} from './capabilityRequirements.js';

/** 最近一次能力验证的只读视图；由 CapabilityValidationJournal 提供。 */
export interface CapabilityValidationLookup {
  record(capability: CapabilityId): CapabilityValidationRecord | undefined;
  isValidating(capability: CapabilityId): boolean;
}

export interface CapabilityStatus {
  /** 兼容字段：只回答「是否已启用」。 */
  capabilities: Record<CapabilityId, boolean>;
  capabilityStates: Record<CapabilityId, CapabilityReadiness>;
}

const EMPTY_LOOKUP: CapabilityValidationLookup = {
  record: () => undefined,
  isValidating: () => false,
};

/**
 * 依赖其他能力的评估放到第二轮，这样工具控制能看到 WebTools / ImageGen / STT
 * 的判定结果，而不用把依赖规则复制一份。
 */
function evaluateDrafts(config: AppConfig): Map<CapabilityId, CapabilityDraft> {
  const resolved = new Map<CapabilityId, CapabilityDraft>();
  const context: CapabilityEvaluationContext = { config, resolved };
  const dependent = new Set<CapabilityId>(DEPENDENT_CAPABILITY_IDS);
  for (const capability of CAPABILITY_IDS) {
    if (dependent.has(capability)) continue;
    resolved.set(capability, CAPABILITY_EVALUATORS[capability](context));
  }
  for (const capability of DEPENDENT_CAPABILITY_IDS) {
    resolved.set(capability, CAPABILITY_EVALUATORS[capability](context));
  }
  return resolved;
}

/** 兼容布尔表与逐能力就绪状态同源产出，避免「已启用」在两处各算一遍后出现分歧。 */
export function buildCapabilityStatus(input: {
  config: AppConfig;
  validations?: CapabilityValidationLookup;
}): CapabilityStatus {
  const validations = input.validations ?? EMPTY_LOOKUP;
  const drafts = evaluateDrafts(input.config);
  const capabilities = {} as Record<CapabilityId, boolean>;
  const capabilityStates = {} as Record<CapabilityId, CapabilityReadiness>;
  for (const capability of CAPABILITY_IDS) {
    const item = drafts.get(capability) ?? { enabled: false, missing: [], blockers: [] };
    const fingerprint = capabilityConfigFingerprint(input.config, capability);
    const lastValidation = validations.record(capability);
    capabilities[capability] = item.enabled;
    capabilityStates[capability] = {
      state: resolveCapabilityState({
        enabled: item.enabled,
        missing: item.missing,
        blockers: item.blockers,
        validating: validations.isValidating(capability),
        configFingerprint: fingerprint,
        ...(lastValidation ? { lastValidation } : {}),
      }),
      missing: [...item.missing].sort(),
      blockers: item.blockers,
      ...(lastValidation ? { lastValidation } : {}),
      targetRouteId: CAPABILITY_TARGET_ROUTES[capability],
    };
  }
  return { capabilities, capabilityStates };
}

export function buildCapabilityReadiness(input: {
  config: AppConfig;
  validations?: CapabilityValidationLookup;
}): Record<CapabilityId, CapabilityReadiness> {
  return buildCapabilityStatus(input).capabilityStates;
}

export function capabilitySnapshot(config: AppConfig): Record<CapabilityId, boolean> {
  return buildCapabilityStatus({ config }).capabilities;
}
