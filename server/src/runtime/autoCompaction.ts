/**
 * 自动上下文压缩判定（/compact v2）。
 *
 * 自动压缩由当前 Agent run 在最终回答之后以内联尾阶段执行：run、session lock 与
 * steering window 在压缩完成前始终保持活跃。这里仅负责按租户开关和模型窗口给出
 * 判定，不再创建独立 `/compact` run。
 */

import {
  getModelAutoCompactThreshold,
  getModelContextWindow,
} from '../data/usage/pricing.js';
import { calculateCurrentContextTokens } from './contextAccounting.js';
import type { PlatformEvent } from './types.js';

export interface AutoCompactionTenantSettingsReader {
  (tenantId: string | undefined): { autoCompactEnabled?: boolean } | undefined;
}

export interface AutoCompactionEvaluationInput {
  /** 可被 resolveRuntimeModelOptions 解析的配置引用（group/model）。 */
  modelRef: string;
  /** provider 实际模型名，用于 usage / context_window 计量。 */
  model: string;
  tenantId?: string;
  /** 该 session 的全量事件。 */
  events: PlatformEvent[];
  /** context governor 等已确认的上下文压力：跳过被裁剪 usage，直接压缩。 */
  force?: boolean;
  forceReason?: string;
}

export interface AutoCompactionEvaluation {
  shouldCompact: boolean;
  reason: string;
  currentTokens?: number;
  contextWindow?: number;
  thresholdRatio?: number;
  thresholdTokens?: number;
}

/**
 * 纯判定逻辑（可单测）：从事件流估算当前上下文并与模型窗口比较。
 *
 * 当前上下文口径与 RuntimeContextUsageTracker 一致：全量请求以最后 leg 重锚；
 * Responses previous_response_id 接力按 (input-cache_read)+output 跨 leg 累加。
 */
export function evaluateAutoCompaction(input: {
  events: PlatformEvent[];
  model: string;
  modelRef?: string;
  autoCompactEnabled: boolean;
}): AutoCompactionEvaluation {
  if (!input.autoCompactEnabled) {
    return { shouldCompact: false, reason: 'tenant_disabled' };
  }
  const contextWindow = getModelContextWindow(input.model, input.modelRef);
  if (!contextWindow) {
    return { shouldCompact: false, reason: 'no_context_window_configured' };
  }
  const thresholdRatio = getModelAutoCompactThreshold(input.model, input.modelRef);
  const thresholdTokens = Math.floor(contextWindow * thresholdRatio);

  let lastUsageIndex = -1;
  let lastCompactionIndex = -1;
  for (let i = input.events.length - 1; i >= 0; i--) {
    const event = input.events[i]!;
    if (lastCompactionIndex < 0 && event.type === 'compaction') {
      lastCompactionIndex = i;
    }
    if (lastUsageIndex < 0
      && (event.type === 'assistant_message' || event.type === 'assistant_tool_calls')
      && event.usage) {
      lastUsageIndex = i;
    }
    if (lastUsageIndex >= 0 && lastCompactionIndex >= 0) break;
  }
  if (lastUsageIndex < 0) {
    return { shouldCompact: false, reason: 'no_usage_events', contextWindow, thresholdRatio, thresholdTokens };
  }
  // 防死循环：最后一次压缩之后还没有新的模型轮 → usage 反映的是压缩前的上下文，
  // 据其触发会无限重压。等下一轮真实交互后再评估。
  if (lastCompactionIndex > lastUsageIndex) {
    return { shouldCompact: false, reason: 'just_compacted', contextWindow, thresholdRatio, thresholdTokens };
  }
  const currentTokens = calculateCurrentContextTokens(input.events, input.model);
  if (currentTokens == null) {
    return { shouldCompact: false, reason: 'no_usage_events', contextWindow, thresholdRatio, thresholdTokens };
  }
  if (currentTokens < thresholdTokens) {
    return {
      shouldCompact: false,
      reason: 'below_threshold',
      currentTokens,
      contextWindow,
      thresholdRatio,
      thresholdTokens,
    };
  }
  return {
    shouldCompact: true,
    reason: 'threshold_exceeded',
    currentTokens,
    contextWindow,
    thresholdRatio,
    thresholdTokens,
  };
}

export class AutoCompactionService {
  constructor(private readonly deps: {
    getTenantSettings: AutoCompactionTenantSettingsReader;
  }) {}

  evaluate(input: AutoCompactionEvaluationInput): AutoCompactionEvaluation {
    const enabled = this.deps.getTenantSettings(input.tenantId)?.autoCompactEnabled === true;
    if (input.force && enabled) {
      return {
        shouldCompact: true,
        reason: input.forceReason ?? 'forced',
        contextWindow: getModelContextWindow(input.model, input.modelRef),
        thresholdRatio: getModelAutoCompactThreshold(input.model, input.modelRef),
      };
    }
    return evaluateAutoCompaction({
      events: input.events,
      model: input.model,
      modelRef: input.modelRef,
      autoCompactEnabled: enabled,
    });
  }
}
