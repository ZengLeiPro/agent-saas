import { mapCanonicalError, type CanonicalError } from '@agent/shared';
import type { RuntimeFailureKind, RuntimeRecoveryAction } from '../types/index.js';
import type { ModelRetryBlockedReason } from './modelRetryTypes.js';

export interface RuntimeFailureProtocol {
  failureKind: RuntimeFailureKind;
  recoveryAction: RuntimeRecoveryAction;
}

export const POLICY_REJECTION_CUSTOMER_MESSAGE = '当前模型受策略限制，请切换其他模型继续。';

export function customerSafeRuntimeError(
  errorMessage: string | undefined,
  failureKind: RuntimeFailureKind | undefined,
): string | undefined {
  return failureKind === 'policy_rejection' ? POLICY_REJECTION_CUSTOMER_MESSAGE : errorMessage;
}

const POLICY_REJECTION_ERROR_CODES = new Set(['cyber_policy']);

/** M40-05 adapter: runtimeFailure remains the runtime authority; UI consumes canonical semantics. */
export function mapRuntimeFailureToCanonical(input: {
  failureKind?: RuntimeFailureKind;
  errorCode?: string;
  correlationId?: string;
  retryAfterMs?: number;
  legacyMessage?: string;
}): CanonicalError {
  const code = input.failureKind === 'policy_rejection'
    ? 'capability_unavailable'
    : input.errorCode;
  return mapCanonicalError({
    source: 'runtime',
    code,
    correlationId: input.correlationId,
    retryAfterMs: input.retryAfterMs,
    legacyMessage: input.legacyMessage,
  });
}

export function classifyModelFailure(
  errorCode: string | undefined,
  retryBlockedReason: ModelRetryBlockedReason | undefined,
): RuntimeFailureProtocol | undefined {
  if (retryBlockedReason !== 'permanent_error' || !errorCode) return undefined;
  if (!POLICY_REJECTION_ERROR_CODES.has(errorCode.toLowerCase())) return undefined;
  return { failureKind: 'policy_rejection', recoveryAction: 'switch_model' };
}

export { SessionAutomationBackgroundResource } from './background/sessionAutomationBackgroundResource.js';
