import {
  parseConfigIdentitySummary,
  type ConfigIdentitySummary,
} from '@agent/shared/schemas/configIdentity';

import type { AttentionItem } from '../runtime/attention.js';

export type ConfigIdentityPayload = ConfigIdentitySummary;

/**
 * 对 Runtime 摘要做 API 边界二次校验，并把漂移/不可验证统一接入概览待关注队列。
 * 无效 wire payload 一律降级为未采集，不能伪装成正常状态。
 */
export function appendConfigIdentityAttention(
  raw: ConfigIdentitySummary | undefined,
  attention: AttentionItem[],
): ConfigIdentitySummary | null {
  const summary = raw ? parseConfigIdentitySummary(raw) : null;
  if (raw && !summary) {
    attention.push({
      kind: 'config_identity_invalid_payload',
      severity: 'high',
      title: '配置身份数据不合法，已降级为未采集',
    });
    return null;
  }
  if (summary?.status === 'drifted') {
    attention.push({
      kind: 'config_identity_drift',
      severity: 'high',
      title: '配置身份漂移：Release 期望与 Runtime 实际配置不一致',
      ...(summary.lastChangedAt ? { occurredAt: summary.lastChangedAt } : {}),
    });
  } else if (summary?.status === 'unverifiable') {
    attention.push({
      kind: 'config_identity_unverifiable',
      severity: 'high',
      title: '配置身份不可验证：无法判定 Release 期望与 Runtime 实际配置是否一致',
      ...(summary.lastObservedAt ? { occurredAt: summary.lastObservedAt } : {}),
    });
  }
  return summary;
}
