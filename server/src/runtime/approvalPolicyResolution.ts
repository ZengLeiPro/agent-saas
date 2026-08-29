import type { ToolApprovalPolicyOptions } from '../agent/types.js';

import type { RawRuntimeRunDispatchConfig } from './rawRuntimeRunDispatchTypes.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('RawRuntime');

export function normalizeApprovalPolicy(value: unknown): ToolApprovalPolicyOptions | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const autoApproveTools = (value as { autoApproveTools?: unknown }).autoApproveTools === true
    || (value as { autoApproveRunShell?: unknown }).autoApproveRunShell === true;
  if (!autoApproveTools) return undefined;
  // 「低风险常开」档（TASK-256）：仅在自动批准开启时有意义。
  return (value as { lowRiskOnly?: unknown }).lowRiskOnly === true
    ? { autoApproveTools: true, lowRiskOnly: true }
    : { autoApproveTools: true };
}

/**
 * 账户偏好是授权模式的服务端权威来源；调用方显式携带的 true 仍兼容旧客户端。
 * resolver 缺失、用户不存在或读取失败时保持原有人工审批语义，不做 fail-open。
 */
export function resolveEffectiveApprovalPolicy(
  config: Pick<RawRuntimeRunDispatchConfig, 'resolveUserAutoApproveTools' | 'resolveUserLowRiskAutoApprove'>,
  requestedPolicy: unknown,
  identity: { userId?: string; username?: string } | undefined,
): ToolApprovalPolicyOptions | undefined {
  const requested = normalizeApprovalPolicy(requestedPolicy);
  if (requested) return requested;
  if (!identity) return undefined;
  try {
    if (config.resolveUserAutoApproveTools?.(identity) === true) {
      return { autoApproveTools: true };
    }
  } catch (err) {
    logger.warn('resolveUserAutoApproveTools 抛错（fail-safe 降级为人工审批）', {
      userId: identity.userId,
      username: identity.username,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
  // 2026-08-29（TASK-256）：「全部授权」未开启时回退到「低风险常开」个人偏好。
  // dangerous 工具仍走人工批准（见 DefaultToolPolicy.decide 的 lowRiskOnly 闸门）。
  try {
    return config.resolveUserLowRiskAutoApprove?.(identity) === true
      ? { autoApproveTools: true, lowRiskOnly: true }
      : undefined;
  } catch (err) {
    logger.warn('resolveUserLowRiskAutoApprove 抛错（fail-safe 降级为人工审批）', {
      userId: identity.userId,
      username: identity.username,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}
