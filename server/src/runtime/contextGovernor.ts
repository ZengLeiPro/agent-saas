import {
  getModelAutoCompactThreshold,
  getModelContextWindow,
} from '../data/usage/pricing.js';
import { truncateOldToolResults } from './legacyTranscriptProjection.js';
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
 * 每次请求模型前重新投影一次当前 run 的内存消息：
 * 1. 所有 tool_result 统一走单条 + 累计预算；
 * 2. 超过模型配置阈值时丢弃较早历史，只保留 system、当前用户任务与最近完整工具轮；
 * 3. 原始事件不改不删，完整内容仍可由 Session 工具检索。
 */
export function governModelRequestMessages(
  messages: ModelChatMessage[],
  model: string,
  currentUserMessageIndex: number,
  currentContextTokens?: number,
): GovernedModelMessages {
  const bounded = truncateOldToolResults(messages);
  const contextWindow = getModelContextWindow(model);
  const thresholdTokens = contextWindow
    ? Math.floor(contextWindow * getModelAutoCompactThreshold(model))
    : undefined;
  const initialEstimate = estimateModelMessageTokens(bounded);
  const triggerTokens = Math.max(initialEstimate, currentContextTokens ?? 0);
  if (!thresholdTokens || triggerTokens < thresholdTokens) {
    return {
      messages: bounded,
      estimatedTokens: initialEstimate,
      triggerTokens,
      ...(thresholdTokens ? { thresholdTokens } : {}),
      forceSynthesis: false,
      droppedMessages: 0,
    };
  }

  const safeCurrentUserIndex = Math.max(0, Math.min(currentUserMessageIndex, bounded.length - 1));
  const systemMessages = bounded
    .slice(0, safeCurrentUserIndex)
    .filter((message) => message.role === 'system');
  const currentUserMessage = bounded[safeCurrentUserIndex];
  const core: ModelChatMessage[] = [
    ...systemMessages,
    {
      role: 'user',
      content: '[平台上下文保护] 较早会话内容已从本次模型请求中省略；事实源仍完整保留，可按需使用 SessionSearchEvents / SessionGetToolTrace 检索。请基于当前任务和最近工具结果收束回答。',
    },
    ...(currentUserMessage ? [currentUserMessage] : []),
  ];
  const groups = groupCompleteTurns(bounded.slice(safeCurrentUserIndex + 1));
  const selectedGroups: ModelChatMessage[][] = [];
  let selected = core;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const candidateGroups = [groups[index]!, ...selectedGroups];
    const candidate = [...core, ...candidateGroups.flat()];
    if (estimateModelMessageTokens(candidate) >= thresholdTokens && selectedGroups.length > 0) break;
    selectedGroups.unshift(groups[index]!);
    selected = candidate;
  }
  const finalMessages = truncateOldToolResults(selected);
  return {
    messages: finalMessages,
    estimatedTokens: estimateModelMessageTokens(finalMessages),
    triggerTokens,
    thresholdTokens,
    forceSynthesis: true,
    droppedMessages: Math.max(0, bounded.length - finalMessages.length),
  };
}

export function estimateModelMessageTokens(messages: ModelChatMessage[]): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(messages), 'utf8') / BYTES_PER_CONSERVATIVE_TOKEN);
}

function groupCompleteTurns(messages: ModelChatMessage[]): ModelChatMessage[][] {
  const groups: ModelChatMessage[][] = [];
  for (const message of messages) {
    if (message.role === 'assistant' || message.role === 'user' || groups.length === 0) {
      groups.push([message]);
    } else {
      groups[groups.length - 1]!.push(message);
    }
  }
  return groups;
}
