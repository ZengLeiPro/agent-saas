import type {
  MessageAttachmentDisplay,
  MessageItem,
  MessageModerationMetadata,
} from '../types/message';
import type { ActivityMessageProjectionState } from './activityMessageProjection';
import { selectProjectedMessages } from './activityMessageProjection';
import type { ToolPresentation } from './toolPresentation';

/** Renderer-neutral timeline contract. React and React Native must only adapt this schema. */
export const RENDER_MODEL_VERSION = 1 as const;

export type RenderTimelineItemKind =
  | 'user_text'
  | 'assistant_text'
  | 'code'
  | 'tool_activity'
  | 'subagent_activity'
  | 'system_status'
  | 'error'
  | 'moderation'
  | 'attachment'
  | 'voice_placeholder';

export type RenderTimelineRole = 'user' | 'assistant' | 'system';
export type RenderTimelineStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'blocked'
  | 'flagged'
  | 'unknown';

export type RenderErrorDomain = 'runtime' | 'transport' | 'tool' | 'subagent' | 'unknown';
export type RenderRetryability = 'retryable' | 'not_retryable' | 'user_action' | 'unknown';

export type RenderContentSegment =
  | { type: 'plain_text'; text: string }
  | { type: 'markdown'; text: string; allowHtml: false }
  | { type: 'code'; text: string; language?: string }
  | { type: 'attachment'; name: string; attachmentId?: string; mimeType?: string; size?: number; isImage?: boolean }
  | { type: 'tool'; toolName: string; input?: string; result?: string; presentation?: ToolPresentation }
  | { type: 'voice'; state: 'placeholder' | 'uploading' | 'transcribing' | 'ready' | 'failed'; durationMs?: number; attachmentId?: string; transcriptionId?: string; transcript?: string }
  | { type: 'unsupported'; label: string };

export interface RenderActionCapabilities {
  copy: boolean;
  retry: boolean;
  fork: boolean;
  expand: boolean;
  download: boolean;
  preview: boolean;
  respondPermission: boolean;
  respondWorkflow: boolean;
  playVoice: boolean;
}

export interface RenderAccessibility {
  role: 'listitem' | 'status' | 'alert';
  label: string;
  live?: 'polite' | 'assertive';
  collapsible?: boolean;
}

export interface RuntimeTimelineProjectionItem {
  id: string;
  type: 'status' | 'error';
  runId?: string;
  status?: RenderTimelineStatus;
  content?: string;
  timestamp?: number;
  domain?: RenderErrorDomain;
  retryability?: RenderRetryability;
}

export type RenderSource =
  | { type: 'message'; message: MessageItem }
  | { type: 'activity'; message: MessageItem }
  | { type: 'runtime'; runtime: RuntimeTimelineProjectionItem }
  | { type: 'fallback' };

export interface RenderTimelineItem {
  /** Stable semantic identity; never uses array position. */
  id: string;
  kind: RenderTimelineItemKind;
  role: RenderTimelineRole;
  content: readonly RenderContentSegment[];
  status: RenderTimelineStatus;
  timestamp?: number;
  /** Stable total order assigned on first semantic occurrence. */
  order: number;
  accessibility: RenderAccessibility;
  actions: RenderActionCapabilities;
  error?: { domain: RenderErrorDomain; retryability: RenderRetryability };
  moderation?: MessageModerationMetadata;
  source: RenderSource;
  /** Deterministic revision used to preserve references during streaming updates. */
  revision: string;
}

export interface RenderModel {
  version: typeof RENDER_MODEL_VERSION;
  items: readonly RenderTimelineItem[];
  byId: Readonly<Record<string, RenderTimelineItem>>;
  stats: {
    inputCount: number;
    outputCount: number;
    reusedCount: number;
    /** Deterministic complexity evidence; never based on wall-clock time. */
    workUnits: number;
  };
}

export interface RenderModelInput {
  /** Canonical durable/live messages. Runtime-invalid values safely fall back. */
  messages?: readonly unknown[];
  /** M20-06 canonical activity/message projection. */
  activity?: ActivityMessageProjectionState;
  /** Optional independently delivered moderation facts; never inferred from text. */
  moderation?: readonly MessageModerationMetadata[];
  /** Runtime lifecycle/errors remain structurally distinct from tool/workflow/moderation. */
  runtime?: readonly RuntimeTimelineProjectionItem[];
}

const NO_ACTIONS: RenderActionCapabilities = {
  copy: false,
  retry: false,
  fork: false,
  expand: false,
  download: false,
  preview: false,
  respondPermission: false,
  respondWorkflow: false,
  playVoice: false,
};

function actions(patch: Partial<RenderActionCapabilities>): RenderActionCapabilities {
  return { ...NO_ACTIONS, ...patch };
}

const MESSAGE_TYPES = new Set([
  'user', 'text', 'system_event', 'thinking', 'tool_use', 'tool_result', 'runtime_status',
  'permission_request', 'ask_user', 'subagent', 'file_download', 'voice', 'user-voice', 'system-error',
]);

function isMessage(value: unknown): value is MessageItem {
  return !!value && typeof value === 'object'
    && typeof (value as { id?: unknown }).id === 'string'
    && typeof (value as { type?: unknown }).type === 'string'
    && MESSAGE_TYPES.has((value as { type: string }).type);
}

function stableId(message: MessageItem): string {
  switch (message.type) {
    case 'user': return `message:user:${message.id}`;
    case 'text': return `message:assistant:${message.runId ?? 'history'}:${message.id}`;
    case 'thinking': return `message:thinking:${message.id}`;
    case 'tool_use': return `tool:${message.runId ?? 'history'}:${message.toolId}`;
    case 'tool_result': return `tool:history:${message.toolId}`;
    case 'subagent': return `subagent:${message.childRunId ?? message.toolId}`;
    case 'runtime_status': return `status:${message.runId ?? message.streamId ?? message.id}`;
    case 'permission_request': return `permission:${message.interactionId}`;
    case 'ask_user': return `workflow:${message.interactionId}`;
    case 'file_download': return `attachment:${message.artifactId ?? message.filePath ?? message.id}`;
    case 'voice':
    case 'user-voice': return `voice:${message.id}`;
    case 'system-error': return `error:${message.runId ?? message.id}`;
    default: return `message:${message.type}:${message.id}`;
  }
}

function statusOf(message: MessageItem): RenderTimelineStatus {
  switch (message.type) {
    case 'user': return message.status === 'sent' ? 'completed' : (message.status ?? 'completed');
    case 'text':
    case 'thinking': return message.streaming ? 'running' : 'completed';
    case 'tool_use': return message.executionStatus ?? (message.streaming ? 'running' : 'completed');
    case 'subagent': return message.status;
    case 'runtime_status':
      return message.status === 'queued' ? 'queued'
        : message.status.startsWith('waiting') ? 'waiting'
          : message.status === 'running' || message.status === 'sending' || message.status === 'reconnecting' ? 'running' : 'unknown';
    case 'permission_request': return message.status === 'pending' ? 'waiting' : message.status === 'denied' ? 'blocked' : 'completed';
    case 'ask_user': return message.status === 'pending' ? 'waiting' : 'completed';
    case 'user-voice': return message.status === 'sent' || message.status === 'ready' ? 'completed' : message.status === 'failed' ? 'failed' : 'running';
    case 'system-error': return message.severity === 'cancelled' ? 'cancelled' : 'failed';
    default: return 'completed';
  }
}

function fencedCode(content: string): { text: string; language?: string } | null {
  const match = /^```([^\n`]*)\n([\s\S]*?)\n```\s*$/.exec(content.trim());
  if (!match) return null;
  const language = match[1].trim().slice(0, 40);
  return { text: match[2], ...(language ? { language } : {}) };
}

const SAFE_ATTACHMENT_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function attachmentSegment(attachment: MessageAttachmentDisplay): RenderContentSegment {
  const safeImage = attachment.isImage === true && !!attachment.mimeType && SAFE_ATTACHMENT_IMAGE_MIMES.has(attachment.mimeType.toLowerCase());
  return {
    type: 'attachment',
    name: attachment.name,
    ...(attachment.attachmentId ? { attachmentId: attachment.attachmentId } : {}),
    ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
    ...(attachment.size !== undefined ? { size: attachment.size } : {}),
    ...(attachment.isImage !== undefined ? { isImage: safeImage } : {}),
  };
}

function messageSemantics(message: MessageItem): {
  kind: RenderTimelineItemKind;
  role: RenderTimelineRole;
  content: RenderContentSegment[];
  accessibility: RenderAccessibility;
  actions: RenderActionCapabilities;
  error?: RenderTimelineItem['error'];
} {
  switch (message.type) {
    case 'user':
      return {
        kind: 'user_text', role: 'user',
        content: [{ type: 'plain_text', text: message.displayContent ?? message.content }, ...(message.attachments ?? []).map(attachmentSegment)],
        accessibility: { role: 'listitem', label: `用户消息：${message.displayContent ?? message.content}` },
        actions: actions({ copy: true, retry: message.status === 'failed', fork: message.status === 'sent' }),
      };
    case 'text': {
      const code = fencedCode(message.content);
      return {
        kind: code ? 'code' : 'assistant_text', role: 'assistant',
        content: code ? [{ type: 'code', ...code }] : [{ type: 'markdown', text: message.content, allowHtml: false }],
        accessibility: { role: message.streaming ? 'status' : 'listitem', label: `助手消息：${message.content}`, ...(message.streaming ? { live: 'polite' as const } : {}), ...(code ? { collapsible: true } : {}) },
        actions: actions({ copy: true, fork: !message.streaming, expand: !!code, playVoice: !!message.content }),
      };
    }
    case 'thinking':
      return {
        kind: 'system_status', role: 'assistant', content: [{ type: 'plain_text', text: message.content }],
        accessibility: { role: 'status', label: message.streaming ? '助手正在思考' : '助手思考过程', live: 'polite', collapsible: true },
        actions: actions({ expand: true }),
      };
    case 'tool_use':
      return {
        kind: 'tool_activity', role: 'assistant',
        content: [{ type: 'tool', toolName: message.toolName, input: message.toolInput, ...(message.result !== undefined ? { result: message.result } : {}), ...(message.presentation ? { presentation: message.presentation } : {}) }],
        accessibility: { role: message.executionStatus === 'failed' ? 'alert' : 'status', label: `工具 ${message.toolName}：${message.executionStatus ?? '已完成'}`, ...(message.executionStatus === 'failed' ? { live: 'assertive' as const } : { live: 'polite' as const }), collapsible: true },
        actions: actions({ expand: true, retry: message.executionStatus === 'failed' }),
        ...(message.executionStatus === 'failed' ? { error: { domain: 'tool' as const, retryability: 'unknown' as const } } : {}),
      };
    case 'tool_result':
      return {
        kind: 'tool_activity', role: 'assistant', content: [{ type: 'tool', toolName: message.toolName, result: message.result, ...(message.presentation ? { presentation: message.presentation } : {}) }],
        accessibility: { role: 'status', label: `工具 ${message.toolName} 已返回结果`, collapsible: true },
        actions: actions({ expand: true }),
      };
    case 'subagent':
      return {
        kind: 'subagent_activity', role: 'assistant',
        content: [{ type: 'plain_text', text: message.resultPreview ?? message.errorMessage ?? message.agentType }],
        accessibility: { role: message.status === 'failed' ? 'alert' : 'status', label: `子任务 ${message.agentType}：${message.status}`, ...(message.status === 'failed' ? { live: 'assertive' as const } : { live: 'polite' as const }), collapsible: true },
        actions: actions({ expand: true, retry: message.status === 'failed' }),
        ...(message.status === 'failed' ? { error: { domain: 'subagent' as const, retryability: message.recoveryAction ? 'user_action' as const : 'unknown' as const } } : {}),
      };
    case 'runtime_status':
      return {
        kind: 'system_status', role: 'system', content: [{ type: 'plain_text', text: message.content ?? message.status }],
        accessibility: { role: 'status', label: `运行状态：${message.content ?? message.status}`, live: 'polite' },
        actions: actions({}),
      };
    case 'permission_request':
      return {
        kind: 'tool_activity', role: 'system', content: [{ type: 'tool', toolName: message.toolName, input: message.toolInput }],
        accessibility: { role: 'status', label: `工具权限请求：${message.toolName}`, live: 'polite', collapsible: true },
        actions: actions({ expand: true, respondPermission: message.status === 'pending' }),
      };
    case 'ask_user':
      return {
        kind: 'system_status', role: 'system', content: [{ type: 'plain_text', text: message.questions.map((question) => question.question).join('；') }],
        accessibility: { role: 'status', label: '工作流正在等待用户回答', live: 'polite' },
        actions: actions({ respondWorkflow: message.status === 'pending' }),
      };
    case 'file_download': {
      const mimeType = message.mimeType ?? message.fileType;
      const safePreview = mimeType === 'application/pdf'
        || SAFE_ATTACHMENT_IMAGE_MIMES.has(mimeType.toLowerCase())
        || mimeType === 'text/markdown'
        || mimeType === 'text/plain'
        || /\.(pdf|png|jpe?g|gif|webp|md|txt)$/i.test(message.fileName);
      return {
        kind: 'attachment', role: 'assistant', content: [{ type: 'attachment', name: message.fileName, mimeType, size: message.fileSize }],
        accessibility: { role: 'listitem', label: `附件：${message.fileName}` },
        actions: actions({ download: true, preview: safePreview }),
      };
    }
    case 'voice':
      return {
        kind: 'voice_placeholder', role: 'assistant', content: [{ type: 'voice', state: 'placeholder', transcript: message.voiceMarkers.map((marker) => marker.text).join('') }],
        accessibility: { role: 'listitem', label: '助手语音消息' }, actions: actions({ playVoice: true }),
      };
    case 'user-voice':
      return {
        kind: 'voice_placeholder', role: 'user', content: [{
          type: 'voice', state: message.status === 'sent' || message.status === 'ready' ? 'ready' : message.status,
          durationMs: Math.max(0, Math.round(message.duration * 1000)),
          ...(message.attachmentId ? { attachmentId: message.attachmentId } : {}),
          ...(message.transcriptionId ? { transcriptionId: message.transcriptionId } : {}),
          ...(message.transcribedText ? { transcript: message.transcribedText } : {}),
        }],
        accessibility: { role: message.status === 'failed' ? 'alert' : 'status', label: `用户语音 ${Math.max(0, Math.round(message.duration))} 秒：${message.status}`, ...(message.status === 'failed' ? { live: 'assertive' as const } : {}) },
        actions: actions({ playVoice: (message.status === 'sent' || message.status === 'ready') && !!message.attachmentId, retry: message.status === 'failed' }),
      };
    case 'system-error': {
      const retryability: RenderRetryability = message.recoveryAction ? 'user_action' : 'unknown';
      return {
        kind: 'error', role: 'system', content: [{ type: 'plain_text', text: message.content }],
        accessibility: { role: 'alert', label: `错误：${message.content}`, live: 'assertive' },
        actions: actions({}), error: { domain: 'runtime', retryability },
      };
    }
    case 'system_event':
      return {
        kind: 'system_status', role: 'system', content: [{ type: 'plain_text', text: `${message.title}：${message.content}` }],
        accessibility: { role: 'status', label: `${message.title}：${message.content}`, live: 'polite' }, actions: actions({}),
      };
    default:
      return {
        kind: 'system_status', role: 'system', content: [{ type: 'unsupported', label: 'Unsupported message' }],
        accessibility: { role: 'status', label: '不支持的消息类型' }, actions: actions({}),
      };
  }
}

function revisionOf(value: unknown): string {
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(revisionOf).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${key}:${revisionOf(item)}`).join(',')}}`;
}

interface Candidate {
  id: string;
  message: MessageItem;
  sourceType: 'message' | 'activity';
  order: number;
}

function mergeMessage(current: MessageItem, incoming: MessageItem): MessageItem {
  if (current.type === 'tool_use' && incoming.type === 'tool_result') {
    return { ...current, result: incoming.result, resultReady: true, ...(incoming.presentation ? { presentation: incoming.presentation } : {}) };
  }
  if (current.type === 'tool_result' && incoming.type === 'tool_use') {
    return { ...incoming, result: incoming.result ?? current.result, resultReady: incoming.resultReady ?? true, presentation: incoming.presentation ?? current.presentation };
  }
  return incoming;
}

function applyModeration(item: RenderTimelineItem, moderation: MessageModerationMetadata): RenderTimelineItem {
  if (moderation.outcome === 'allowed') return { ...item, moderation };
  const status = moderation.outcome;
  const label = `内容审核：${moderation.outcome}${moderation.reasonCode ? `（${moderation.reasonCode}）` : ''}`;
  return {
    ...item,
    kind: 'moderation',
    status,
    moderation,
    accessibility: { role: moderation.outcome === 'blocked' ? 'alert' : 'status', label, live: moderation.outcome === 'blocked' ? 'assertive' : 'polite' },
    revision: `${item.revision}|moderation:${revisionOf(moderation)}`,
  };
}

/**
 * Pure presenter/selector. Pass the previous model to retain unchanged item references while
 * streaming; output remains deterministic for the same (input, previous) pair.
 */
export function selectRenderModel(input: RenderModelInput, previous?: RenderModel): RenderModel {
  const candidates = new Map<string, Candidate>();
  let inputCount = 0;
  let workUnits = 0;
  let nextOrder = previous?.items.reduce((max, item) => Math.max(max, item.order + 1), 0) ?? 0;
  const previousOrder = new Map(previous?.items.map((item) => [item.id, item.order]) ?? []);

  const addMessage = (raw: unknown, sourceType: Candidate['sourceType']) => {
    inputCount += 1;
    workUnits += 3;
    if (!isMessage(raw)) {
      const rawId = raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string'
        ? (raw as { id: string }).id : String(inputCount);
      const id = `fallback:${sourceType}:${rawId}`;
      const fallback: MessageItem = { id, type: 'system_event', title: 'Unsupported message', content: 'This message type is not supported.' };
      candidates.set(id, { id, message: fallback, sourceType, order: previousOrder.get(id) ?? nextOrder++ });
      return;
    }
    const id = stableId(raw);
    const current = candidates.get(id);
    if (current) {
      current.message = mergeMessage(current.message, raw);
      if (sourceType === 'message') current.sourceType = sourceType;
      workUnits += 2;
      return;
    }
    candidates.set(id, { id, message: raw, sourceType, order: previousOrder.get(id) ?? nextOrder++ });
  };

  for (const message of input.messages ?? []) addMessage(message, 'message');
  for (const message of input.activity ? selectProjectedMessages(input.activity) : []) addMessage(message, 'activity');

  const moderationByTarget = new Map<string, MessageModerationMetadata>();
  const moderationByBlock = new Map<string, MessageModerationMetadata>();
  for (const moderation of input.moderation ?? []) {
    inputCount += 1;
    workUnits += 2;
    moderationByTarget.set(`${moderation.messageId}:${moderation.blockId ?? ''}`, moderation);
    if (moderation.blockId) moderationByBlock.set(moderation.blockId, moderation);
  }

  const result: RenderTimelineItem[] = [];
  for (const candidate of candidates.values()) {
    workUnits += 4;
    const semantics = messageSemantics(candidate.message);
    const message = candidate.message;
    const embeddedModeration = ('moderation' in message ? message.moderation : undefined) as MessageModerationMetadata | undefined;
    const targetMessageId = message.type === 'user' ? message.id : ('runId' in message ? message.runId : undefined);
    const explicitModeration = moderationByBlock.get(message.id)
      ?? moderationByTarget.get(`${targetMessageId ?? ''}:${message.id}`)
      ?? moderationByTarget.get(`${message.id}:`);
    const status = statusOf(message);
    const revision = revisionOf(message);
    let item: RenderTimelineItem = {
      id: candidate.id,
      kind: semantics.kind,
      role: semantics.role,
      content: semantics.content,
      status,
      ...(('timestamp' in message && typeof message.timestamp === 'number') ? { timestamp: message.timestamp } : {}),
      order: candidate.order,
      accessibility: semantics.accessibility,
      actions: semantics.actions,
      ...(semantics.error ? { error: semantics.error } : {}),
      source: { type: candidate.sourceType, message },
      revision,
    };
    const moderation = embeddedModeration ?? explicitModeration;
    if (moderation) item = applyModeration(item, moderation);
    result.push(item);
  }

  for (const runtime of input.runtime ?? []) {
    inputCount += 1;
    workUnits += 5;
    const id = runtime.type === 'error' ? `error:${runtime.runId ?? runtime.id}` : `status:${runtime.runId ?? runtime.id}`;
    if (candidates.has(id) || result.some((item) => item.id === id)) continue;
    const isError = runtime.type === 'error';
    const status = runtime.status ?? (isError ? 'failed' : 'running');
    const revision = revisionOf(runtime);
    result.push({
      id,
      kind: isError ? 'error' : 'system_status',
      role: 'system',
      content: [{ type: 'plain_text', text: runtime.content ?? status }],
      status,
      ...(runtime.timestamp !== undefined ? { timestamp: runtime.timestamp } : {}),
      order: previousOrder.get(id) ?? nextOrder++,
      accessibility: { role: isError ? 'alert' : 'status', label: `${isError ? '错误' : '运行状态'}：${runtime.content ?? status}`, live: isError ? 'assertive' : 'polite' },
      actions: actions({ retry: runtime.retryability === 'retryable' }),
      ...(isError ? { error: { domain: runtime.domain ?? 'unknown', retryability: runtime.retryability ?? 'unknown' } } : {}),
      source: { type: 'runtime', runtime },
      revision,
    });
  }

  result.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const priorById = previous?.byId ?? {};
  let reusedCount = 0;
  const items = result.map((item) => {
    const prior = priorById[item.id];
    if (prior && prior.revision === item.revision && prior.order === item.order) {
      reusedCount += 1;
      return prior;
    }
    return item;
  });
  const byId = Object.fromEntries(items.map((item) => [item.id, item]));
  workUnits += items.length * 2;
  return {
    version: RENDER_MODEL_VERSION,
    items,
    byId,
    stats: { inputCount, outputCount: items.length, reusedCount, workUnits },
  };
}

/** Cross-platform adapter tests compare this instead of component implementation details. */
export function renderSemanticSignature(item: RenderTimelineItem): string {
  return `${item.id}|${item.kind}|${item.role}|${item.status}|${item.accessibility.role}|${item.accessibility.label}`;
}
