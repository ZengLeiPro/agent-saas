import { estimateContextTokens } from './contextBreakdown.js';
import { buildChatMessagesFromEvents } from './legacyTranscriptProjection.js';
import type {
  CheckpointTaskAnchor,
  ModelAttachmentRef,
  ModelChatMessage,
  PlatformEvent,
} from './types.js';

export const CONTEXT_CHECKPOINT_VERSION = 1;
export const CHECKPOINT_SUMMARY_CONTEXT_RATIO = 0.08;
export const CHECKPOINT_SUMMARY_TOKEN_CAP = 16_384;
export const CHECKPOINT_RAW_TAIL_TOKEN_CAP = 65_536;
export const CHECKPOINT_TARGET_THRESHOLD_RATIO = 0.5;
/** 正常会话保持全部确定性用户轨迹；仅极端长会话超过此预算后退化最早消息。 */
export const CHECKPOINT_USER_HISTORY_TOKEN_CAP = 60_000;

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
  /** 仅在模型窗口是可信配置值时启用；未知窗口的临时估算不应用来裁掉用户历史。 */
  adaptUserHistoryToTarget?: boolean;
}

export interface ContextCheckpointPlan {
  version: typeof CONTEXT_CHECKPOINT_VERSION;
  targetTokens: number;
  summaryBudgetTokens: number;
  rawTailBudgetTokens: number;
  fixedTokens: number;
  userHistoryTokenCap: number;
  memorySnapshot?: string;
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

function latestMemorySnapshot(events: PlatformEvent[]): { index: number; content: string } | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === 'memory_context') return { index, content: event.content };
  }
  return undefined;
}

function checkpointProjectionFixedTokens(
  events: PlatformEvent[],
  taskAnchors: CheckpointTaskAnchor[],
  userHistoryTokenCap: number,
  memorySnapshot?: string,
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
    return [{
      eventId: event.id,
      timestamp: event.timestamp,
      text: content,
      originalChars: content.length,
    }];
  });
  return Math.min(
    estimateContextTokens({ taskAnchors, userTrajectory }),
    userHistoryTokenCap,
  ) + estimateContextTokens(memorySnapshot ?? '') + CHECKPOINT_PROTOCOL_TOKEN_RESERVE;
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

function compactionSourceText(event: PlatformEvent): string | undefined {
  switch (event.type) {
    case 'user_message': {
      const attachments = event.attachments?.map((attachment) => (
        `${attachment.originalName ?? '附件'}(attachmentId=${attachment.attachmentId})`
      )).join(', ');
      return [event.modelContent ?? event.content, attachments ? `附件：${attachments}` : ''].filter(Boolean).join('\n');
    }
    case 'memory_context':
    case 'assistant_message':
    case 'assistant_thinking':
      return event.content;
    case 'tool_result':
      return `tool_result callId=${event.toolCallId} tool=${event.toolName}\n${event.content}`;
    case 'assistant_tool_calls':
      return [event.content, ...event.toolCalls.map((call) => (
        `tool_call callId=${call.id} tool=${call.name} arguments=${call.arguments}`
      ))].filter(Boolean).join('\n');
    case 'mcp_tools_loaded':
      return `已加载 MCP 工具：${event.tools.map((tool) => tool.name).join(', ')}`;
    default:
      return undefined;
  }
}

function fitCompactionSourceText(content: string, tokenBudget: number): string {
  if (tokenBudget <= 0) return '';
  if (estimateContextTokens(content) <= tokenBudget) return content;
  let low = 0;
  let high = content.length;
  let best = '';
  while (low <= high) {
    const retainedChars = Math.floor((low + high) / 2);
    const headChars = Math.ceil(retainedChars * 0.7);
    const candidate = `${content.slice(0, headChars)}\n……[中间内容因首次压缩输入预算省略]……\n${content.slice(-(retainedChars - headChars))}`;
    if (estimateContextTokens(candidate) <= tokenBudget) {
      best = candidate;
      low = retainedChars + 1;
    } else {
      high = retainedChars - 1;
    }
  }
  return best;
}

/** 首次 checkpoint 尚无旧摘要可折叠时，将超窗原始历史降级为有界、可总结的事件摘录。 */
export function buildBoundedInitialCompactionMessages(
  events: PlatformEvent[],
  tokenBudget: number,
): ModelChatMessage[] {
  const budget = Math.max(0, Math.floor(tokenBudget));
  const rawMessages = buildChatMessagesFromEvents(events);
  if (estimateContextTokens(rawMessages) <= budget) return rawMessages;
  if (budget <= 0) return [];

  const resultsByCallId = new Map<string, Array<Extract<PlatformEvent, { type: 'tool_result' }>>>();
  for (const event of events) {
    if (event.type !== 'tool_result') continue;
    const results = resultsByCallId.get(event.toolCallId) ?? [];
    results.push(event);
    resultsByCallId.set(event.toolCallId, results);
  }
  const groupedResultIds = new Set<string>();
  const entries: Array<{ index: number; event: PlatformEvent; text: string }> = [];
  for (const [index, event] of events.entries()) {
    if (event.type === 'tool_result' && groupedResultIds.has(event.id)) continue;
    const texts = [compactionSourceText(event)?.trim() ?? ''];
    if (event.type === 'assistant_tool_calls') {
      for (const call of event.toolCalls) {
        for (const result of resultsByCallId.get(call.id) ?? []) {
          groupedResultIds.add(result.id);
          texts.push(compactionSourceText(result) ?? '');
        }
      }
    }
    const text = texts.filter(Boolean).join('\n\n');
    if (text) entries.push({ index, event, text });
  }
  const selected = new Map<number, string>();
  const userEntries = entries.filter(({ event }) => event.type === 'user_message');
  const priority = [userEntries[0], userEntries.at(-1)].filter((entry) => entry !== undefined);
  const candidates = [...priority, ...entries.slice().reverse()];
  const wrapper = '<context-compaction-source>\n这是首次 checkpoint 的有界历史摘录；被省略的原始事件仍可通过 SessionContext 检索。\n\n';
  const wrapperTokens = estimateContextTokens(`${wrapper}\n</context-compaction-source>`) + 32;
  let remaining = Math.max(0, budget - wrapperTokens);
  for (const entry of candidates) {
    if (selected.has(entry.index) || remaining <= 0) continue;
    const label = `[${entry.event.timestamp} ${entry.event.type} eventId=${entry.event.id}]`;
    const labelTokens = estimateContextTokens(label);
    const excerptBudget = Math.min(2_048, Math.max(0, remaining - labelTokens));
    const excerpt = fitCompactionSourceText(entry.text, excerptBudget);
    if (!excerpt) continue;
    const block = `${label}\n${excerpt}`;
    const blockTokens = estimateContextTokens(block)
      + (selected.size > 0 ? estimateContextTokens('\n\n') : 0);
    if (blockTokens > remaining) continue;
    selected.set(entry.index, block);
    remaining -= blockTokens;
  }
  const render = () => {
    const body = [...selected.entries()].sort(([left], [right]) => left - right).map(([, block]) => block).join('\n\n');
    return `${wrapper}${body}\n</context-compaction-source>`;
  };
  let content = render();
  while (estimateContextTokens(content) > budget && selected.size > 0) {
    selected.delete([...selected.keys()].at(-1)!);
    content = render();
  }
  return estimateContextTokens(content) <= budget ? [{ role: 'user', content }] : [];
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

  // 逐个原子单元只投影一次并累加上界，避免 O(n²)，也不依赖“切片越短 Token
  // 必然越少”的假设（历史图片会按切片内最近轮次重新裁剪，单调性并不成立）。
  // 每单元独立投影会保留更多图片/continuation 和数组外壳，因此是完整后缀的保守上界。
  const unsafePrefix = new Array<number>(events.length + 1).fill(0);
  for (let index = 0; index < events.length; index += 1) {
    unsafePrefix[index + 1] = unsafePrefix[index]! + (unsafeIndices.has(index) ? 1 : 0);
  }
  const acceptedStarts: number[] = [];
  let estimatedUpperTokens = 0;
  let cursor = events.length - 1;
  while (cursor >= 0) {
    // 旧 checkpoint 必须进入下一次摘要投影，才能应用当前模型的更小 cap；
    // 不能把 model-invisible compaction 当作 0 Token raw-tail 单元单独保留。
    if (events[cursor]!.type === 'compaction') break;
    const range = rangeByIndex.get(cursor);
    let unitStart = range?.start ?? cursor;
    const first = events[unitStart]!;
    if (first.type === 'assistant_message' || first.type === 'assistant_tool_calls') {
      let scan = unitStart - 1;
      let pendingStart = unitStart;
      let foundThinking = false;
      while (scan >= 0) {
        const previous = events[scan]!;
        if (previous.type === 'assistant_thinking' && previous.runId === first.runId) {
          foundThinking = true;
          pendingStart = scan;
          scan -= 1;
          continue;
        }
        // 渐进式 MCP 加载不会清空 pendingReasoning；若它夹在 thinking 与 assistant
        // 输出之间，也必须随同一个原子单元保留或压缩。
        if (previous.type === 'mcp_tools_loaded' && previous.runId === first.runId) {
          pendingStart = scan;
          scan -= 1;
          continue;
        }
        break;
      }
      if (foundThinking) unitStart = pendingStart;
    }
    const unsafeCount = unsafePrefix[cursor + 1]! - unsafePrefix[unitStart]!;
    if (unsafeCount > 0) break;
    const unitTokens = estimateRawEventTokens(events.slice(unitStart, cursor + 1));
    if (estimatedUpperTokens + unitTokens > rawTailBudgetTokens) break;
    estimatedUpperTokens += unitTokens;
    acceptedStarts.push(unitStart);
    cursor = unitStart - 1;
  }
  if (acceptedStarts.length === 0) return { startIndex: events.length, observedTokens: 0 };

  let selectedStart = acceptedStarts.at(-1)!;
  let selectedTokens = estimateRawEventTokens(events.slice(selectedStart));
  // 防御性兜底：若未来投影规则打破“单元和为上界”，只缩短尾部，绝不突破预算。
  while (selectedTokens > rawTailBudgetTokens && acceptedStarts.length > 1) {
    acceptedStarts.pop();
    selectedStart = acceptedStarts.at(-1)!;
    selectedTokens = estimateRawEventTokens(events.slice(selectedStart));
  }
  if (selectedTokens > rawTailBudgetTokens) {
    return { startIndex: events.length, observedTokens: 0 };
  }
  return { startIndex: selectedStart, observedTokens: selectedTokens };
}

export function planContinuousCheckpointInput(
  events: PlatformEvent[],
  payloadBudgetTokens: number,
): { retainedStartIndex: number; summaryTokenCap: number } {
  let checkpointIndex = events.length - 1;
  while (checkpointIndex >= 0 && events[checkpointIndex]!.type !== 'compaction') checkpointIndex -= 1;
  if (checkpointIndex < 0) {
    return { retainedStartIndex: events.length, summaryTokenCap: Math.max(0, payloadBudgetTokens) };
  }
  const newerEvents = events.slice(checkpointIndex + 1);
  const retained = selectAtomicRawTail(newerEvents, Math.floor(Math.max(0, payloadBudgetTokens) / 2));
  return {
    retainedStartIndex: checkpointIndex + 1 + retained.startIndex,
    summaryTokenCap: Math.max(0, payloadBudgetTokens - retained.observedTokens),
  };
}

export function planContextCheckpoint(input: ContextCheckpointPlanInput): ContextCheckpointPlan {
  const contextWindow = Math.max(1, Math.floor(input.contextWindow));
  const thresholdTokens = Math.max(1, Math.floor(input.thresholdTokens));
  const targetTokens = Math.floor(thresholdTokens * CHECKPOINT_TARGET_THRESHOLD_RATIO);
  const summaryBudgetTokens = Math.min(
    Math.floor(contextWindow * CHECKPOINT_SUMMARY_CONTEXT_RATIO),
    CHECKPOINT_SUMMARY_TOKEN_CAP,
  );
  const allTaskAnchors = extractCheckpointTaskAnchors(input.events, input.sourceRunId);
  const baseFixedTokens = Math.max(0, Math.floor(input.baseFixedTokens ?? 0));
  const latestMemory = latestMemorySnapshot(input.events);
  let rawTailBudgetTokens = CHECKPOINT_RAW_TAIL_TOKEN_CAP;
  let rawTail = selectAtomicRawTail(input.events, rawTailBudgetTokens);
  let fixedTokens = baseFixedTokens;
  let userHistoryTokenCap = CHECKPOINT_USER_HISTORY_TOKEN_CAP;
  let compressedTaskAnchors: CheckpointTaskAnchor[] = [];
  let memorySnapshot: string | undefined;

  // 从乐观的最大 raw-tail 预算开始，按候选 cutoff 只计费压缩前缀的用户轨迹。
  // cutoff 后移只会把更多内容转入 checkpoint，预算单调收紧，最终得到稳定切点。
  for (let attempt = 0; attempt <= input.events.length + 1; attempt += 1) {
    const compressedEvents = input.events.slice(0, rawTail.startIndex);
    const compressedEventIds = new Set(compressedEvents.map((event) => event.id));
    compressedTaskAnchors = allTaskAnchors.filter((anchor) => compressedEventIds.has(anchor.eventId));
    memorySnapshot = latestMemory && latestMemory.index < rawTail.startIndex
      ? latestMemory.content
      : undefined;
    const memoryTokens = estimateContextTokens(memorySnapshot ?? '');
    userHistoryTokenCap = input.adaptUserHistoryToTarget === false
      ? CHECKPOINT_USER_HISTORY_TOKEN_CAP
      : Math.min(
        CHECKPOINT_USER_HISTORY_TOKEN_CAP,
        Math.max(
          0,
          targetTokens - baseFixedTokens - summaryBudgetTokens
            - memoryTokens - CHECKPOINT_PROTOCOL_TOKEN_RESERVE,
        ),
      );
    fixedTokens = baseFixedTokens + checkpointProjectionFixedTokens(
      compressedEvents,
      compressedTaskAnchors,
      userHistoryTokenCap,
      memorySnapshot,
    );
    const nextBudget = Math.min(
      CHECKPOINT_RAW_TAIL_TOKEN_CAP,
      Math.max(0, targetTokens - fixedTokens - summaryBudgetTokens),
    );
    if (nextBudget === rawTailBudgetTokens) break;
    rawTailBudgetTokens = Math.min(rawTailBudgetTokens, nextBudget);
    rawTail = selectAtomicRawTail(input.events, rawTailBudgetTokens);
  }

  return {
    version: CONTEXT_CHECKPOINT_VERSION,
    targetTokens,
    summaryBudgetTokens,
    rawTailBudgetTokens,
    fixedTokens,
    userHistoryTokenCap,
    ...(memorySnapshot ? { memorySnapshot } : {}),
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
