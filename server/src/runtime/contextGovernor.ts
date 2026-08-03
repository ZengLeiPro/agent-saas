import {
  getModelAutoCompactThreshold,
  getModelContextWindow,
} from '../data/usage/pricing.js';
import type { ModelChatMessage } from './types.js';

const BYTES_PER_CONSERVATIVE_TOKEN = 3;

export interface GovernedModelMessages {
  messages: ModelChatMessage[];
  estimatedTokens: number;
  triggerTokens: number;
  thresholdTokens?: number;
  forceSynthesis: boolean;
  droppedMessages: number;
}

/**
 * 请求前只判定上下文压力，不再改写 model-visible 历史。
 * tool_result 在首次进入消息数组时已经完成固定投影；达到阈值后由 RawAgentLoop
 * 停止扩展工具调用并在最终回答后交给现有 auto compact。
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
  const initialEstimate = estimateModelMessageTokens(messages);
  const triggerTokens = Math.max(initialEstimate, currentContextTokens ?? 0);
  return {
    messages,
    estimatedTokens: initialEstimate,
    triggerTokens,
    ...(thresholdTokens ? { thresholdTokens } : {}),
    forceSynthesis: Boolean(thresholdTokens && triggerTokens >= thresholdTokens),
    droppedMessages: 0,
  };
}

export function estimateModelMessageTokens(messages: ModelChatMessage[]): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(messages), 'utf8') / BYTES_PER_CONSERVATIVE_TOKEN);
}
