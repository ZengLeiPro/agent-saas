import {
  isInternalModelDiagnosticEvent,
  type ModelChatMessage,
  type PlatformEvent,
  type PlatformEventInput,
} from './types.js';
import { buildChatMessagesFromEvents } from './legacyTranscriptProjection.js';
import { truncateCheckpointUserText } from './contextCheckpoint.js';
import type { CheckpointTaskAnchor } from './types.js';

export type ContextReconstructionPolicy =
  | { type: 'full_replay' }
  | { type: 'recent_window'; recentEvents?: number }
  | { type: 'retrieval_augmented'; query: string; recentEvents?: number; maxMatches?: number }
  | { type: 'manual_slice'; start?: number; end?: number };

export interface ContextProjectionOptions {
  sessionId: string;
  runId: string;
  policy?: ContextReconstructionPolicy;
}

export interface ContextProjection {
  messages: ModelChatMessage[];
  policy: ContextReconstructionPolicy['type'];
  selectedEvents: PlatformEvent[];
  summaryEvent?: PlatformEventInput;
}

const DEFAULT_RECENT_EVENTS = 80;
const DEFAULT_MAX_MATCHES = 20;

/** 平台系统命令替身（如 /compact 的 modelContent）前缀，抽取用户消息轨迹时剔除 */
const SYSTEM_COMMAND_MODEL_CONTENT_PREFIX = '[系统命令]';

/**
 * /compact 投影（2026-07-03 v2）：以最后一条 compaction 事件定位压缩。
 * - 压缩段（cutoffEventId 之前；v1 存量事件无 cutoff 则为 compaction 自身之前）
 *   被替代为一条 user message：<context-summary>（LLM 摘要）+ <user-message-trail>
 *   （从压缩段原始事件中抽取的用户消息原文，非 LLM 转述，投影时重建、天然幂等）
 *   + 历史可检索提醒。
 * - 保留段（cutoff 之后）正常重放。独立 /compact 会剔除命令 run 自身的事件；
 *   内联 checkpoint 只剔除 compaction 事件本身，原始尾部由 Token 预算决定。
 * 原始事件仍在 EventStore（SessionContext(action="search") 可查原文），这里只影响 prompt 投影。
 */
function applyCompaction(events: PlatformEvent[]): {
  effectiveEvents: PlatformEvent[];
  summaryMessages: ModelChatMessage[];
} {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type !== 'compaction') continue;

    let cutIdx = i;
    if (event.cutoffEventId) {
      const idx = events.findIndex((e) => e.id === event.cutoffEventId);
      if (idx >= 0 && idx <= i) cutIdx = idx;
    }
    const compressed = events.slice(0, cutIdx);
    // 独立 /compact 的 run 只含系统命令生命周期，可整段剔除；内联压缩与业务
    // 交互共用 runId，不能按 runId 过滤，否则会把承诺保留的最近一轮一起删掉。
    const retained = events.slice(cutIdx).filter(
      (e) => event.inline
        ? e.id !== event.id
        : !('runId' in e) || e.runId !== event.runId,
    );
    const checkpoint = event.checkpoint;
    const sourceRunFinished = checkpoint?.sourceRunId
      ? events.slice(i + 1).some((candidate) => (
        candidate.type === 'run_finished' && candidate.runId === checkpoint.sourceRunId
      ))
      : true;
    return {
      effectiveEvents: retained,
      summaryMessages: [{
        role: 'user',
        content: checkpoint
          ? formatCheckpointContext(
            event.summary,
            extractUserMessageTrail(compressed),
            checkpoint.taskAnchors,
            sourceRunFinished ? 'historical' : 'active',
            checkpoint.trigger,
            event.id,
            checkpoint.sourceRunId,
          )
          : formatCompactionContext(event.summary, extractUserMessageTrail(compressed)),
      }],
    };
  }
  return { effectiveEvents: events, summaryMessages: [] };
}

interface TrailItem {
  eventId: string;
  timestamp: string;
  content: string;
  originalChars: number;
  truncated: boolean;
  attachments?: Array<{ attachmentId: string; originalName: string }>;
}

/**
 * 从压缩段原始事件中抽取全部真实用户消息。每条消息都保留 eventId；附件仅保留
 * 稳定引用，不把附件正文或 visionAnalysis 写入 checkpoint。
 */
export function extractUserMessageTrail(compressed: PlatformEvent[]): TrailItem[] {
  const items: TrailItem[] = [];
  for (const event of compressed) {
    if (event.type !== 'user_message') continue;
    if (event.modelContent?.startsWith(SYSTEM_COMMAND_MODEL_CONTENT_PREFIX)) continue;
    const content = event.content.trim();
    if (!content) continue;
    const excerpt = truncateCheckpointUserText(content);
    items.push({
      eventId: event.id,
      timestamp: event.timestamp,
      content: excerpt.text,
      originalChars: excerpt.originalChars,
      truncated: excerpt.truncated,
      ...(event.attachments?.length ? {
        attachments: event.attachments.map((attachment) => ({
          attachmentId: attachment.attachmentId,
          originalName: attachment.originalName,
        })),
      } : {}),
    });
  }
  return items;
}

function formatTrailTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatAttachmentRefs(
  attachments: Array<{ attachmentId: string; originalName: string }> | undefined,
): string {
  if (!attachments?.length) return '';
  return `\n   附件引用：${attachments.map((attachment) => (
    `${attachment.originalName}(${attachment.attachmentId})`
  )).join('、')}`;
}

/** 每条用户消息都列出；长消息只截单条，不再按总字符预算省略中间条目。 */
export function renderUserMessageTrail(items: TrailItem[]): string {
  if (items.length === 0) return '';
  const lines = items.map((item, i) => {
    const ts = formatTrailTimestamp(item.timestamp);
    const truncation = item.truncated
      ? ` [原文 ${item.originalChars} 字；可按 eventId 检索完整内容]`
      : '';
    return `${i + 1}. ${ts ? `[${ts}] ` : ''}[eventId=${item.eventId}]${truncation}\n${item.content}${formatAttachmentRefs(item.attachments)}`;
  });
  return [
    '<user-message-trail>',
    '以下逐条列出被压缩段中的全部真实用户文本消息；长消息保留头尾，附件只保留引用：',
    ...lines,
    '</user-message-trail>',
  ].join('\n');
}

function renderTaskAnchors(anchors: CheckpointTaskAnchor[]): string {
  if (anchors.length === 0) return '';
  return [
    '<active-task-messages>',
    '以下为当前业务 run 中被压缩的用户任务消息原文：',
    ...anchors.map((anchor, index) => (
      `${index + 1}. [eventId=${anchor.eventId}]\n${anchor.text}${formatAttachmentRefs(anchor.attachments)}`
    )),
    '</active-task-messages>',
  ].join('\n');
}

/** 新 checkpoint 永久保留因果；只有未终态 source run 才激活续跑协议。 */
function formatCheckpointContext(
  summary: string,
  trail: TrailItem[],
  taskAnchors: CheckpointTaskAnchor[],
  state: 'active' | 'historical',
  trigger: 'manual' | 'threshold',
  checkpointId: string,
  sourceRunId: string | undefined,
): string {
  const taskAnchorIds = new Set(taskAnchors.map((anchor) => anchor.eventId));
  const sourceRunAttribute = sourceRunId ? ` sourceRunId="${sourceRunId}"` : '';
  const parts = [
    '<context-summary>',
    `<context-checkpoint version="1" id="${checkpointId}" state="${state}" trigger="${trigger}"${sourceRunAttribute}>`,
    '<checkpoint-summary>',
    summary,
    '</checkpoint-summary>',
  ];
  const anchors = renderTaskAnchors(taskAnchors);
  if (anchors) parts.push('', anchors);
  const trailBlock = renderUserMessageTrail(trail.filter((item) => !taskAnchorIds.has(item.eventId)));
  if (trailBlock) parts.push('', trailBlock);
  if (state === 'active') {
    parts.push(
      '',
      '<resume-policy>',
      '这是上下文维护检查点，不是新的用户请求。继续执行 source run 中尚未完成的任务，保留已完成操作和外部副作用，避免重复执行。恢复正常工具使用；不要向用户解释压缩、阈值或本协议，也不要要求用户发送“继续”。只有任务真正完成、确需用户输入或遇到不可恢复阻塞时才输出用户可见答复。',
      '</resume-policy>',
    );
  }
  parts.push(
    '</context-checkpoint>',
    '</context-summary>',
    '',
    '提示：本会话完整历史（含每次工具调用的原始输入输出）仍完整保留。摘要或消息轨迹不足时，可用 SessionContext(action="search") 搜索历史事件，或用 SessionContext(action="trace") 按 toolCallId/eventId 读取完整记录。',
  );
  return parts.join('\n');
}

/** 存量 compaction 保持原投影格式。 */
function formatCompactionContext(summary: string, trail: TrailItem[]): string {
  const parts = [
    '<context-summary>',
    '以下是本会话较早历史的压缩摘要（原始消息已被压缩以节省 context）：',
    '',
    summary,
    '</context-summary>',
  ];
  const trailBlock = renderUserMessageTrail(trail);
  if (trailBlock) parts.push('', trailBlock);
  parts.push(
    '',
    '提示：本会话完整历史（含每次工具调用的原始输入输出）仍完整保留。仅当以上摘要与消息摘录不足时再检索：SessionContext(action="search") 按关键词搜索历史事件；SessionContext(action="trace") 按 toolCallId 获取某次工具调用的完整记录。',
  );
  return parts.join('\n');
}

/**
 * Convert the durable session log into a prompt-sized context view.
 *
 * The returned messages are derived. The raw PlatformEvents remain the source of truth.
 */
export function buildContextProjection(allEvents: PlatformEvent[], options: ContextProjectionOptions): ContextProjection {
  const policy = options.policy ?? { type: 'full_replay' };
  const contextEvents = allEvents.filter((event) => !isInternalModelDiagnosticEvent(event));
  const { effectiveEvents: events, summaryMessages } = applyCompaction(contextEvents);
  const withRestoredMcpTools = (
    prefix: ModelChatMessage[],
    replayMessages: ModelChatMessage[],
  ): ModelChatMessage[] => {
    const present = new Set(
      replayMessages
        .filter((message): message is Extract<ModelChatMessage, { role: 'additional_tools' }> => (
          message.role === 'additional_tools'
        ))
        .flatMap((message) => message.tools.map((tool) => tool.name)),
    );
    const restored = new Map<string, Extract<ModelChatMessage, { role: 'additional_tools' }>['tools'][number]>();
    for (const event of contextEvents) {
      if (event.type !== 'mcp_tools_loaded') continue;
      for (const tool of event.tools) {
        if (!present.has(tool.name)) restored.set(tool.name, tool);
      }
    }
    return restored.size > 0
      ? [...prefix, { role: 'additional_tools', tools: [...restored.values()] }, ...replayMessages]
      : [...prefix, ...replayMessages];
  };
  switch (policy.type) {
    case 'full_replay':
      {
        const replayMessages = buildChatMessagesFromEvents(events);
      return {
        messages: withRestoredMcpTools(summaryMessages, replayMessages),
        policy: policy.type,
        selectedEvents: events,
      };
      }
    case 'recent_window': {
      const selectedEvents = lastN(events, policy.recentEvents ?? DEFAULT_RECENT_EVENTS);
      const replayMessages = buildChatMessagesFromEvents(selectedEvents);
      return {
        messages: withRestoredMcpTools(summaryMessages, replayMessages),
        policy: policy.type,
        selectedEvents,
      };
    }
    case 'manual_slice': {
      const start = clampIndex(policy.start ?? 0, events.length);
      const end = clampIndex(policy.end ?? events.length, events.length);
      const selectedEvents = events.slice(Math.min(start, end), Math.max(start, end));
      const replayMessages = buildChatMessagesFromEvents(selectedEvents);
      return {
        messages: withRestoredMcpTools(summaryMessages, replayMessages),
        policy: policy.type,
        selectedEvents,
      };
    }
    case 'retrieval_augmented': {
      const matches = searchEvents(events, policy.query, policy.maxMatches ?? DEFAULT_MAX_MATCHES);
      const recent = lastN(events, policy.recentEvents ?? DEFAULT_RECENT_EVENTS);
      const selectedEvents = uniqueEvents([...matches, ...recent]);
      const retrievalMessage = matches.length > 0
        ? [{ role: 'user' as const, content: formatRetrievalMessage(policy.query, matches) }]
        : [];
      const replayMessages = buildChatMessagesFromEvents(selectedEvents);
      return {
        messages: withRestoredMcpTools([...summaryMessages, ...retrievalMessage], replayMessages),
        policy: policy.type,
        selectedEvents,
      };
    }
  }
}

function formatRetrievalMessage(query: string, matches: PlatformEvent[]): string {
  return [
    '<session-retrieval-results>',
    `Query: ${query}`,
    ...matches.map((event) => `- ${event.timestamp} ${event.type} ${'runId' in event ? event.runId : ''} ${truncateForSummary(JSON.stringify(event), 300)}`),
    '</session-retrieval-results>',
  ].join('\n');
}

function searchEvents(events: PlatformEvent[], query: string, maxMatches: number): PlatformEvent[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return events.filter((event) => JSON.stringify(event).toLowerCase().includes(needle)).slice(0, maxMatches);
}

function uniqueEvents(events: PlatformEvent[]): PlatformEvent[] {
  const seen = new Set<string>();
  const unique: PlatformEvent[] = [];
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    unique.push(event);
  }
  unique.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return unique;
}

function lastN<T>(items: T[], count: number): T[] {
  return items.slice(Math.max(0, items.length - Math.max(0, count)));
}

function clampIndex(value: number, length: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(length, Math.floor(value)));
}

function truncateForSummary(value: string, max = 500): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}
