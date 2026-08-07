import {
  getModelAutoCompactThreshold,
  getModelContextWindow,
} from '../data/usage/pricing.js';
import type { ModelChatMessage } from './types.js';

export interface GovernedModelMessages {
  messages: ModelChatMessage[];
  triggerTokens: number;
  thresholdTokens?: number;
  shouldCompactBeforeRequest: boolean;
  droppedMessages: number;
}

/**
 * 请求前只判定上下文压力，不再改写 model-visible 历史。
 * tool_result 在首次进入消息数组时已经完成固定投影；达到阈值后由 RawAgentLoop
 * 在下一次模型请求前建立 checkpoint，重建上下文后继续同一 run。
 *
 * 2026-08-04 起判定只用模型 API 返回的真实上下文口径（RuntimeContextUsageTracker，
 * provider usage 派生：全量重锚 / Responses relay 净新增累计），不再做字节估算——
 * 旧 `JSON.stringify(messages)/3` 对代码/英文内容（实测 ~5.2 bytes/token）高估约
 * 70%，曾把 272K 窗口的等效触发线压到 ~130K（生产会话 737ab4a3 实证）。
 * 首轮尚无 usage 时不触发：单轮增量不会瞬间越过阈值余量（窗口的 20%），
 * 下一轮拿到真实 usage 后自然生效。
 */
export function governModelRequestMessages(
  messages: ModelChatMessage[],
  model: string,
  _currentUserMessageIndex: number,
  currentContextTokens?: number,
  modelRef?: string,
): GovernedModelMessages {
  const contextWindow = getModelContextWindow(model, modelRef);
  const thresholdTokens = contextWindow
    ? Math.floor(contextWindow * getModelAutoCompactThreshold(model, modelRef))
    : undefined;
  const triggerTokens = currentContextTokens ?? 0;
  return {
    messages,
    triggerTokens,
    ...(thresholdTokens ? { thresholdTokens } : {}),
    shouldCompactBeforeRequest: Boolean(thresholdTokens && triggerTokens >= thresholdTokens),
    droppedMessages: 0,
  };
}
