import type { AppConfig } from '../app/config.js';

import {
  CAPABILITY_IDS,
  CAPABILITY_TARGET_ROUTES,
  capabilityConfigFingerprint,
  resolveCapabilityState,
  resolveCapabilityVerification,
  type CapabilityId,
  type CapabilityReadiness,
  type CapabilityValidationRecord,
} from './capabilityContract.js';
import {
  CAPABILITY_EVALUATORS,
  DEPENDENT_CAPABILITY_IDS,
  type CapabilityDraft,
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
 * 兼容布尔表与逐能力就绪状态同源产出，避免「已启用」在两处各算一遍后出现分歧。
 *
 * 分两轮：先算不依赖别人的能力并直接落成最终 state，再把这些 state 交给依赖类
 * 能力（工具控制）。第二轮拿到的是并入验证记录后的 state，所以「依赖探测失败」
 * 会被如实识别，而不是只看开关和字段。
 */
export function buildCapabilityStatus(input: {
  config: AppConfig;
  validations?: CapabilityValidationLookup;
}): CapabilityStatus {
  const validations = input.validations ?? EMPTY_LOOKUP;
  const dependencies = new Map<CapabilityId, CapabilityReadiness>();
  const enabledFlags = new Map<CapabilityId, boolean>();
  const dependent = new Set<CapabilityId>(DEPENDENT_CAPABILITY_IDS);

  const resolve = (capability: CapabilityId, draft: CapabilityDraft): void => {
    const fingerprint = capabilityConfigFingerprint(input.config, capability);
    const lastValidation = validations.record(capability);
    const verification = resolveCapabilityVerification(lastValidation, fingerprint);
    const readiness: CapabilityReadiness = {
      state: resolveCapabilityState({
        enabled: draft.enabled,
        missing: draft.missing,
        blockers: draft.blockers,
        validating: validations.isValidating(capability),
        verification,
      }),
      verification,
      missing: [...draft.missing].sort(),
      blockers: draft.blockers,
      ...(lastValidation ? { lastValidation } : {}),
      targetRouteId: CAPABILITY_TARGET_ROUTES[capability],
    };
    enabledFlags.set(capability, draft.enabled);
    dependencies.set(capability, readiness);
  };

  for (const capability of CAPABILITY_IDS) {
    if (dependent.has(capability)) continue;
    resolve(capability, CAPABILITY_EVALUATORS[capability]({ config: input.config, dependencies }));
  }
  for (const capability of DEPENDENT_CAPABILITY_IDS) {
    resolve(capability, CAPABILITY_EVALUATORS[capability]({ config: input.config, dependencies }));
  }

  // 输出顺序始终按 CAPABILITY_IDS，不受两轮评估顺序影响。
  const capabilities = {} as Record<CapabilityId, boolean>;
  const capabilityStates = {} as Record<CapabilityId, CapabilityReadiness>;
  for (const capability of CAPABILITY_IDS) {
    capabilities[capability] = enabledFlags.get(capability) === true;
    capabilityStates[capability] = dependencies.get(capability)!;
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
