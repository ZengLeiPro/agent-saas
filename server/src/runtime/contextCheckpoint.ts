import { estimateContextTokens } from './contextBreakdown.js';
import { buildChatMessagesFromEvents } from './legacyTranscriptProjection.js';
import type {
  CheckpointTaskAnchor,
  ModelAttachmentRef,
  PlatformEvent,
} from './types.js';

export const CONTEXT_CHECKPOINT_VERSION = 1;
export const CHECKPOINT_SUMMARY_CONTEXT_RATIO = 0.08;
export const CHECKPOINT_SUMMARY_TOKEN_CAP = 16_384;
export const CHECKPOINT_RAW_TAIL_TOKEN_CAP = 65_536;
export const CHECKPOINT_TARGET_THRESHOLD_RATIO = 0.5;

const USER_TEXT_MAX_CHARS = 500;
const USER_TEXT_HEAD_CHARS = 360;
const USER_TEXT_TAIL_CHARS = 140;
const CHECKPOINT_PROTOCOL_TOKEN_RESERVE = 256;

export interface ContextCheckpointPlanInput {
  events: PlatformEvent[];
  contextWindow: number;
  thresholdTokens: number;
  /** system prompt、memory、工具定义等不会被 checkpoint 替代的固定成本。 */
  baseFixedTokens?: number;
  sourceRunId?: string;
}

export interface ContextCheckpointPlan {
  version: typeof CONTEXT_CHECKPOINT_VERSION;
  targetTokens: number;
  summaryBudgetTokens: number;
  rawTailBudgetTokens: number;
  fixedTokens: number;
  rawTailObservedTokens: number;
  rawTailStartIndex: number;
  rawTailStartEventId?: string;
  coveredEventCount: number;
  taskAnchors: CheckpointTaskAnchor[];
}

export function truncateCheckpointUserText(content: string): {
  text: string;
  originalChars: number;
  truncated: boolean;
} {
  const originalChars = content.length;
  if (originalChars <= USER_TEXT_MAX_CHARS) {
    return { text: content, originalChars, truncated: false };
  }
  return {
    text: `${content.slice(0, USER_TEXT_HEAD_CHARS)}\n……[中间已省略 ${originalChars - USER_TEXT_HEAD_CHARS - USER_TEXT_TAIL_CHARS} 字；原文可按 eventId 检索]……\n${content.slice(-USER_TEXT_TAIL_CHARS)}`,
    originalChars,
    truncated: true,
  };
}

function attachmentRefs(attachments: ModelAttachmentRef[] | undefined): CheckpointTaskAnchor['attachments'] {
  return attachments?.map((attachment) => ({
    attachmentId: attachment.attachmentId,
    originalName: attachment.originalName,
  }));
}

/** 当前业务 run 的用户原始任务锚点。附件只保留稳定引用，不保留正文或视觉分析。 */
export function extractCheckpointTaskAnchors(
  events: PlatformEvent[],
  sourceRunId: string | undefined,
): CheckpointTaskAnchor[] {
  if (!sourceRunId) return [];
  return events.flatMap((event): CheckpointTaskAnchor[] => {
    if (
      event.type !== 'user_message'
      || event.runId !== sourceRunId
      || event.modelContent?.startsWith('[系统命令]')
    ) return [];
    const text = event.content.trim();
    if (!text) return [];
    const attachments = attachmentRefs(event.attachments);
    return [{
      eventId: event.id,
      timestamp: event.timestamp,
      text,
      originalChars: text.length,
      ...(attachments?.length ? { attachments } : {}),
    }];
  });
}

function checkpointProjectionFixedTokens(
  events: PlatformEvent[],
  taskAnchors: CheckpointTaskAnchor[],
): number {
  const taskAnchorIds = new Set(taskAnchors.map((anchor) => anchor.eventId));
  const userTrajectory = events.flatMap((event) => {
    if (
      event.type !== 'user_message'
      || event.modelContent?.startsWith('[系统命令]')
      || taskAnchorIds.has(event.id)
    ) return [];
    const content = event.content.trim();
    if (!content) return [];
    const excerpt = truncateCheckpointUserText(content);
    return [{
      eventId: event.id,
      timestamp: event.timestamp,
      text: excerpt.text,
      originalChars: excerpt.originalChars,
    }];
  });
  return estimateContextTokens({ taskAnchors, userTrajectory }) + CHECKPOINT_PROTOCOL_TOKEN_RESERVE;
}

interface AtomicRange {
  start: number;
  end: number;
}

/** assistant_tool_calls 与其全部 tool_result 必须整体保留或整体压缩。 */
function buildAtomicToolRanges(events: PlatformEvent[]): {
  ranges: AtomicRange[];
  unsafeIndices: Set<number>;
} {
  const callIndexById = new Map<string, number>();
  const resultIndicesById = new Map<string, number[]>();
  for (const [index, event] of events.entries()) {
    if (event.type === 'assistant_tool_calls') {
      for (const call of event.toolCalls) callIndexById.set(call.id, index);
    } else if (event.type === 'tool_result') {
      const indices = resultIndicesById.get(event.toolCallId) ?? [];
      indices.push(index);
      resultIndicesById.set(event.toolCallId, indices);
    }
  }

  const unsafeIndices = new Set<number>();
  const ranges: AtomicRange[] = [];
  for (const [index, event] of events.entries()) {
    if (event.type !== 'assistant_tool_calls') continue;
    const resultIndices = event.toolCalls.flatMap((call) => (
      (resultIndicesById.get(call.id) ?? []).filter((resultIndex) => resultIndex > index)
    ));
    const complete = event.toolCalls.length > 0 && event.toolCalls.every((call) => (
      (resultIndicesById.get(call.id) ?? []).some((resultIndex) => resultIndex > index)
    ));
    if (!complete) {
      unsafeIndices.add(index);
      for (const resultIndex of resultIndices) unsafeIndices.add(resultIndex);
      continue;
    }
    ranges.push({ start: index, end: Math.max(...resultIndices) });
  }
  for (const [index, event] of events.entries()) {
    if (event.type !== 'tool_result') continue;
    const callIndex = callIndexById.get(event.toolCallId);
    if (callIndex === undefined || callIndex >= index) unsafeIndices.add(index);
  }

  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: AtomicRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return { ranges: merged, unsafeIndices };
}

function estimateRawEventTokens(events: PlatformEvent[]): number {
  return estimateContextTokens(buildChatMessagesFromEvents(events));
}

export function selectAtomicRawTail(
  events: PlatformEvent[],
  rawTailBudgetTokens: number,
): { startIndex: number; observedTokens: number } {
  if (events.length === 0 || rawTailBudgetTokens <= 0) {
    return { startIndex: events.length, observedTokens: 0 };
  }
  const { ranges, unsafeIndices } = buildAtomicToolRanges(events);
  const rangeByIndex = new Map<number, AtomicRange>();
  for (const range of ranges) {
    for (let index = range.start; index <= range.end; index += 1) rangeByIndex.set(index, range);
  }

  let startIndex = events.length;
  let observedTokens = 0;
  let cursor = events.length - 1;
  while (cursor >= 0) {
    if (unsafeIndices.has(cursor)) break;
    const range = rangeByIndex.get(cursor);
    const unitStart = range?.start ?? cursor;
    const candidate = events.slice(unitStart);
    if (candidate.some((_, relativeIndex) => unsafeIndices.has(unitStart + relativeIndex))) break;
    const candidateTokens = estimateRawEventTokens(candidate);
    if (candidateTokens > rawTailBudgetTokens) break;
    startIndex = unitStart;
    observedTokens = candidateTokens;
    cursor = unitStart - 1;
  }
  return { startIndex, observedTokens };
}

export function planContextCheckpoint(input: ContextCheckpointPlanInput): ContextCheckpointPlan {
  const contextWindow = Math.max(1, Math.floor(input.contextWindow));
  const thresholdTokens = Math.max(1, Math.floor(input.thresholdTokens));
  const targetTokens = Math.floor(thresholdTokens * CHECKPOINT_TARGET_THRESHOLD_RATIO);
  const summaryBudgetTokens = Math.min(
    Math.floor(contextWindow * CHECKPOINT_SUMMARY_CONTEXT_RATIO),
    CHECKPOINT_SUMMARY_TOKEN_CAP,
  );
  const taskAnchors = extractCheckpointTaskAnchors(input.events, input.sourceRunId);
  const fixedTokens = Math.max(0, Math.floor(input.baseFixedTokens ?? 0))
    + checkpointProjectionFixedTokens(input.events, taskAnchors);
  const rawTailBudgetTokens = Math.min(
    CHECKPOINT_RAW_TAIL_TOKEN_CAP,
    Math.max(0, targetTokens - fixedTokens - summaryBudgetTokens),
  );
  const rawTail = selectAtomicRawTail(input.events, rawTailBudgetTokens);
  const compressedEventIds = new Set(
    input.events.slice(0, rawTail.startIndex).map((event) => event.id),
  );
  const compressedTaskAnchors = taskAnchors.filter((anchor) => compressedEventIds.has(anchor.eventId));
  return {
    version: CONTEXT_CHECKPOINT_VERSION,
    targetTokens,
    summaryBudgetTokens,
    rawTailBudgetTokens,
    fixedTokens,
    rawTailObservedTokens: rawTail.observedTokens,
    rawTailStartIndex: rawTail.startIndex,
    ...(input.events[rawTail.startIndex] ? { rawTailStartEventId: input.events[rawTail.startIndex]!.id } : {}),
    coveredEventCount: rawTail.startIndex,
    taskAnchors: compressedTaskAnchors,
  };
}

export function hasActiveCheckpointForRun(events: PlatformEvent[], runId: string): boolean {
  let latestCheckpointIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (
      event.type === 'compaction'
      && event.checkpoint?.version === CONTEXT_CHECKPOINT_VERSION
      && event.checkpoint.sourceRunId === runId
    ) {
      latestCheckpointIndex = index;
      break;
    }
  }
  if (latestCheckpointIndex < 0) return false;
  return !events.slice(latestCheckpointIndex + 1).some((event) => (
    event.type === 'run_finished' && event.runId === runId
  ));
}
