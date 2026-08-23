import type { RuntimeFailureKind, RuntimeRecoveryAction } from '../types/index.js';
import type { ModelRetryBlockedReason } from './modelRetryTypes.js';

export interface RuntimeFailureProtocol {
  failureKind: RuntimeFailureKind;
  recoveryAction: RuntimeRecoveryAction;
}

export const POLICY_REJECTION_CUSTOMER_MESSAGE = '当前模型受策略限制，请切换其他模型继续。';

const POLICY_REJECTION_ERROR_CODES = new Set(['cyber_policy']);

export function classifyModelFailure(
  errorCode: string | undefined,
  retryBlockedReason: ModelRetryBlockedReason | undefined,
): RuntimeFailureProtocol | undefined {
  if (retryBlockedReason !== 'permanent_error' || !errorCode) return undefined;
  if (!POLICY_REJECTION_ERROR_CODES.has(errorCode.toLowerCase())) return undefined;
  return { failureKind: 'policy_rejection', recoveryAction: 'switch_model' };
}
