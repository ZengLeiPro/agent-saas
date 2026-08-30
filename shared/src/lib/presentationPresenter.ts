import type { TodoStatus } from './extractTodos';
import { normalizeTodoDisplay } from './extractTodos';
import type { PresentationBlock, PresentationTone, RecordItem } from './presentation/types';
import type { RenderTimelineItem, RenderTimelineStatus } from './renderModel';
import {
  selectCardViewModelFromRenderItem,
  selectToolCardViewModel,
  type CardViewModel,
} from './cardViewModel';
import {
  normalizeDetailLine,
  normalizeToolPresentation,
  type DetailLine,
  type ToolReceipt,
} from './toolPresentation';

/** Renderer-neutral presentation contract shared by Tool and BusinessStep surfaces. */
export interface SharedPresentation {
  title: string;
  tone: PresentationTone;
  receipt?: ToolReceipt;
  detail: readonly DetailLine[];
  display: readonly PresentationBlock[];
  evidence: readonly string[];
  /** Raw payloads live in the existing card model; this flag is their only disclosure authority. */
  showRaw: boolean;
}

/** The three independent raw-disclosure gates. Missing/malformed gates are closed. */
export interface RawPresentationGate {
  debugBuild?: boolean;
  authenticatedAdmin?: boolean;
  explicitSessionToggle?: boolean;
  /** Compatibility spelling for callers whose setting is named `sessionRawEnabled`. */
  sessionRawEnabled?: boolean;
}

export type SharedPresentationKind = 'tool' | 'business_step';

export interface SharedPresentationPresenterInput {
  kind: SharedPresentationKind | string;
  source: unknown;
}

export const PRESENTATION_STRUCTURE_BUDGET = Object.freeze({
  maxDepth: 8,
  maxNodes: 8_192,
  maxEntriesPerObject: 120,
  maxArrayItems: 4_096,
  maxSourceText: 2_048,
});

const EMPTY_ACTIONS = Object.freeze({
  copy: false,
  retry: false,
  fork: false,
  expand: false,
  download: false,
  preview: false,
  respondPermission: false,
  respondWorkflow: false,
  playVoice: false,
});

const RENDER_STATUSES = new Set<RenderTimelineStatus>([
  'pending',
  'queued',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'timeout',
  'blocked',
  'flagged',
  'unknown',
]);
const TODO_STATUSES = new Set<TodoStatus>([
  'pending',
  'in_progress',
  'waiting',
  'blocked',
  'completed',
  'failed',
]);

interface SnapshotBudget {
  nodes: number;
  seen: WeakSet<object>;
}

/**
 * Copies only own data properties within a fixed budget. Accessors are ignored, so an untrusted
 * transcript cannot execute getters while the presenter is normalizing it.
 */
function boundedSnapshot(
  value: unknown,
  budget: SnapshotBudget = { nodes: 0, seen: new WeakSet() },
  depth = 0,
): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  )
    return value;
  if (typeof value === 'string') return value.slice(0, PRESENTATION_STRUCTURE_BUDGET.maxSourceText);
  if (typeof value !== 'object' || depth >= PRESENTATION_STRUCTURE_BUDGET.maxDepth)
    return undefined;
  if (budget.nodes >= PRESENTATION_STRUCTURE_BUDGET.maxNodes || budget.seen.has(value))
    return undefined;
  budget.nodes += 1;
  budget.seen.add(value);

  try {
    if (Array.isArray(value)) {
      const output: unknown[] = [];
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      const length =
        typeof lengthDescriptor?.value === 'number'
          ? Math.min(lengthDescriptor.value, PRESENTATION_STRUCTURE_BUDGET.maxArrayItems)
          : 0;
      for (
        let index = 0;
        index < length && budget.nodes < PRESENTATION_STRUCTURE_BUDGET.maxNodes;
        index += 1
      ) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor)) continue;
        output.push(boundedSnapshot(descriptor.value, budget, depth + 1));
      }
      return output;
    }

    const output: Record<string, unknown> = {};
    const keys = Object.keys(value).slice(0, PRESENTATION_STRUCTURE_BUDGET.maxEntriesPerObject);
    for (const key of keys) {
      if (budget.nodes >= PRESENTATION_STRUCTURE_BUDGET.maxNodes) break;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) continue;
      const child = boundedSnapshot(descriptor.value, budget, depth + 1);
      if (child !== undefined) output[key] = child;
    }
    return output;
  } catch {
    return undefined;
  } finally {
    budget.seen.delete(value);
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const FORBIDDEN_CONTROL =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g;
const HTML = /<\/?[a-z][^>]*>|&(?:lt|gt|#x?0*3[ce]);/i;
const URL = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i;
const PATH = /(?:^|[\s"'(])(?:\.{0,2}[\\/]|[a-z]:[\\/]|\\\\)|[\\/][^\s/\\]+[\\/]/i;
const RELATIVE_PATH =
  /(?:^|[\s"'(])(?=[^\s]*(?:[A-Za-z_.]|[\u4e00-\u9fff]))(?:[A-Za-z0-9_.\-\u4e00-\u9fff]+[\\/])+[A-Za-z0-9_.\-\u4e00-\u9fff]+/;
const SECRET =
  /(?:authorization|bearer|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|id[ _-]?token|client[ _-]?secret|private[ _-]?key|password|passwd|secret|token)\s*[:=]/i;
const SENSITIVE_LABEL =
  /^(?:authorization|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|id[ _-]?token|client[ _-]?secret|private[ _-]?key|password|passwd|secret|token|path|file[ _-]?path|relative[ _-]?path|absolute[ _-]?path)$/i;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;

function safeText(value: unknown, maxLength = 500): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(FORBIDDEN_CONTROL, '').trim();
  if (
    !text ||
    HTML.test(text) ||
    URL.test(text) ||
    PATH.test(text) ||
    RELATIVE_PATH.test(text) ||
    SECRET.test(text) ||
    JWT.test(text)
  )
    return undefined;
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      JSON.parse(text);
      return undefined;
    } catch {
      // Human text beginning with punctuation remains allowed.
    }
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function sanitizeReceipt(receipt: ToolReceipt | undefined): ToolReceipt | undefined {
  if (!receipt) return undefined;
  const system = safeText(receipt.system, 40);
  const id = receipt.id.includes('://')
    ? !/[?#]/.test(receipt.id) && !SECRET.test(receipt.id) && !JWT.test(receipt.id)
      ? receipt.id
      : undefined
    : safeText(receipt.id, 120);
  if (!system || !id) return undefined;
  return { id, system, ...(receipt.readBack !== undefined ? { readBack: receipt.readBack } : {}) };
}

function sanitizeDetail(raw: unknown): DetailLine[] {
  if (!Array.isArray(raw)) return [];
  const output: DetailLine[] = [];
  for (const item of raw.slice(0, 60)) {
    const line = normalizeDetailLine(item);
    if (line === null) continue;
    if (typeof line === 'string') {
      const text = safeText(line);
      if (text) output.push(text);
      continue;
    }
    if ('k' in line) {
      const k = safeText(line.k);
      const v = safeText(line.v);
      if (k && !SENSITIVE_LABEL.test(k) && v !== undefined)
        output.push('tree' in line ? { tree: line.tree, k, v } : { k, v });
    } else if ('no' in line) {
      const text = safeText(line.text);
      if (text) output.push({ no: line.no, text });
    } else if ('indent' in line) {
      const text = safeText(line.text);
      if (text) output.push({ indent: line.indent, text });
    } else if ('section' in line) {
      const section = safeText(line.section);
      if (section) output.push({ section });
    } else if ('warn' in line) {
      const warn = safeText(line.warn);
      if (warn) output.push({ warn });
    } else if ('insight' in line) {
      const insight = safeText(line.insight);
      const label = safeText(line.label);
      if (insight) output.push(label ? { insight, label } : { insight });
    } else if ('risk' in line) {
      const text = safeText(line.text);
      const action = safeText(line.action);
      if (text) output.push(action ? { risk: line.risk, text, action } : { risk: line.risk, text });
    } else if ('verdict' in line) {
      const text = safeText(line.text);
      const note = safeText(line.note);
      if (text)
        output.push(note ? { verdict: line.verdict, text, note } : { verdict: line.verdict, text });
    } else if ('quote' in line) {
      const quote = safeText(line.quote);
      const source = safeText(line.source);
      if (quote) output.push(source ? { quote, source } : { quote });
    } else if ('original' in line) {
      const original = safeText(line.original);
      const translation = safeText(line.translation);
      if (original) output.push(translation ? { original, translation } : { original });
    } else if ('fields' in line) {
      const fields = line.fields.flatMap((field) => {
        const k = safeText(field.k);
        const v = safeText(field.v);
        return k && !SENSITIVE_LABEL.test(k) && v !== undefined ? [{ k, v }] : [];
      });
      if (fields.length) output.push({ fields });
    }
  }
  return output;
}

function sanitizeRecordItem(item: RecordItem): RecordItem | null {
  const label = safeText(item.label);
  if (!label || SENSITIVE_LABEL.test(label)) return null;
  const value = safeText(item.value);
  const baseline = safeText(item.baseline);
  const current = safeText(item.current);
  const delta = safeText(item.delta);
  const note = safeText(item.note);
  const tagText = safeText(item.tag?.text);
  const detail = sanitizeDetail(item.detail);
  return {
    label,
    ...(value ? { value } : {}),
    ...(baseline ? { baseline } : {}),
    ...(current ? { current } : {}),
    ...(delta ? { delta } : {}),
    ...(tagText && item.tag ? { tag: { tone: item.tag.tone, text: tagText } } : {}),
    ...(note ? { note } : {}),
    ...(item.tone ? { tone: item.tone } : {}),
    ...(detail.length ? { detail } : {}),
    ...(item.mono ? { mono: true } : {}),
  };
}

function sanitizeDisplay(raw: unknown): PresentationBlock[] {
  const normalized = normalizeTodoDisplay(raw) ?? [];
  return normalized.flatMap((block): PresentationBlock[] => {
    if (block.kind === 'callout') {
      const body = block.body.flatMap((line) => {
        const safe = safeText(line);
        return safe ? [safe] : [];
      });
      const detail = sanitizeDetail(block.detail);
      if (!body.length && !detail.length) return [];
      const title = safeText(block.title);
      return [
        {
          kind: 'callout',
          tone: block.tone,
          body,
          ...(title ? { title } : {}),
          ...(detail.length ? { detail } : {}),
          ...(block.collapsible ? { collapsible: true } : {}),
          ...(block.defaultOpen ? { defaultOpen: true } : {}),
        },
      ];
    }
    if (block.kind === 'records') {
      const items = block.items
        .map(sanitizeRecordItem)
        .filter((item): item is RecordItem => item !== null);
      if (!items.length) return [];
      const title = safeText(block.title);
      const footer = safeText(block.footer);
      return [
        {
          kind: 'records',
          layout: block.layout,
          items,
          ...(title ? { title } : {}),
          ...(footer ? { footer } : {}),
        },
      ];
    }
    return [];
  });
}

export function canShowRawPresentation(gate: RawPresentationGate | undefined): boolean {
  const safe = record(boundedSnapshot(gate));
  return (
    safe?.debugBuild === true &&
    safe.authenticatedAdmin === true &&
    (safe.explicitSessionToggle === true || safe.sessionRawEnabled === true)
  );
}

function toolTone(status: RenderTimelineStatus, businessStatus: unknown): PresentationTone {
  if (status === 'failed' || status === 'timeout' || status === 'blocked') return 'danger';
  if (status === 'cancelled') return 'muted';
  if (businessStatus === 'warn') return 'warn';
  if (businessStatus === 'blocked') return 'danger';
  if (businessStatus === 'waiting') return 'warn';
  if (status === 'running' || status === 'pending' || status === 'queued' || status === 'waiting')
    return 'info';
  if (status === 'completed' && businessStatus === 'ok') return 'success';
  return status === 'completed' ? 'success' : 'neutral';
}

function minimalToolItem(
  source: Record<string, unknown>,
  toolName: string,
  status: RenderTimelineStatus,
): RenderTimelineItem {
  const id = safeText(source.id, 100) ?? 'unavailable';
  return {
    id,
    kind: 'tool_activity',
    role: 'assistant',
    content: [{ type: 'tool', toolName }],
    status,
    order: 0,
    accessibility: { role: status === 'failed' ? 'alert' : 'status', label: '工具活动' },
    actions: EMPTY_ACTIONS,
    ...(status === 'failed'
      ? { error: { domain: 'tool' as const, retryability: 'unknown' as const } }
      : {}),
    source: { type: 'fallback' },
    revision: '',
  };
}

/** Presents a RenderModel tool item without copying its raw input/result into this schema. */
export function selectToolPresentation(
  item: unknown,
  gate?: RawPresentationGate,
): SharedPresentation {
  const source = record(boundedSnapshot(item));
  const rawContent = Array.isArray(source?.content) ? source.content : [];
  const segment = rawContent.map(record).find((entry) => entry?.type === 'tool') ?? null;
  const rawToolName = safeText(segment?.toolName, 120) ?? '工具';
  const status =
    typeof source?.status === 'string' && RENDER_STATUSES.has(source.status as RenderTimelineStatus)
      ? (source.status as RenderTimelineStatus)
      : 'unknown';
  const card = selectToolCardViewModel({
    item: minimalToolItem(source ?? {}, rawToolName, status),
  });
  const normalized = normalizeToolPresentation(segment?.presentation);
  const title = safeText(normalized?.title, 500) ?? safeText(card.title, 500) ?? '工具';
  const detail = sanitizeDetail(normalized?.detail);
  const receipt = sanitizeReceipt(normalized?.receipt);
  return {
    title,
    tone: toolTone(status, normalized?.status),
    ...(receipt ? { receipt } : {}),
    detail,
    display: [],
    evidence: [],
    showRaw: canShowRawPresentation(gate),
  };
}

function eventStatus(source: Record<string, unknown>): TodoStatus | undefined {
  if (typeof source.status === 'string' && TODO_STATUSES.has(source.status as TodoStatus))
    return source.status as TodoStatus;
  const kind = source.kind;
  if (kind === 'start') return 'in_progress';
  if (kind === 'complete') return 'completed';
  if (kind === 'fail') return 'failed';
  if (kind === 'block') return 'blocked';
  if (kind === 'wait') return 'waiting';
  return undefined;
}

function businessTone(status: TodoStatus | undefined, outcomeTone: unknown): PresentationTone {
  if (outcomeTone === 'fail') return 'danger';
  if (outcomeTone === 'warn') return 'warn';
  if (status === 'failed' || status === 'blocked') return 'danger';
  if (status === 'waiting') return 'warn';
  if (status === 'in_progress') return 'info';
  if (status === 'completed') return outcomeTone === 'ok' ? 'success' : 'success';
  if (status === 'pending') return 'muted';
  return 'neutral';
}

/** Presents either a TodoItem or a BusinessStepEventItem. All six Todo states are authoritative. */
export function selectBusinessStepPresentation(
  step: unknown,
  gate?: RawPresentationGate,
): SharedPresentation {
  const source = record(boundedSnapshot(step));
  const nestedTodo = record(source?.todo);
  const todo = nestedTodo ?? source;
  const outcome = record(todo?.outcome);
  const status = eventStatus(todo ?? source ?? {});
  const eventKind = typeof source?.kind === 'string' ? source.kind : undefined;
  const title =
    safeText(todo?.content, 500) ??
    (eventKind === 'plan' ? '业务计划' : eventKind === 'update' ? '计划已调整' : '业务步骤不可用');
  const outcomeText = safeText(outcome?.text, 120);
  const detail = [
    ...(outcomeText ? [{ insight: outcomeText } satisfies DetailLine] : []),
    ...sanitizeDetail(todo?.detail),
  ].slice(0, 60);
  const evidence = Array.isArray(todo?.evidenceRefs)
    ? todo.evidenceRefs.slice(0, 20).flatMap((entry) => {
        const safe = safeText(entry, 200);
        return safe ? [safe] : [];
      })
    : [];
  const planItems =
    eventKind === 'plan' && Array.isArray(source?.todos)
      ? source.todos.slice(0, 100).flatMap((entry): RecordItem[] => {
          const planTodo = record(entry);
          const label = safeText(planTodo?.content, 500);
          const planStatus = planTodo ? eventStatus(planTodo) : undefined;
          if (!label) return [];
          const statusLabel: Partial<Record<TodoStatus, string>> = {
            pending: '待开始',
            in_progress: '进行中',
            waiting: '等待中',
            blocked: '已阻断',
            completed: '已完成',
            failed: '失败',
          };
          const tone: Partial<Record<TodoStatus, PresentationTone>> = {
            pending: 'muted',
            in_progress: 'info',
            waiting: 'warn',
            blocked: 'danger',
            completed: 'success',
            failed: 'danger',
          };
          return [
            {
              label,
              ...(planStatus ? { value: statusLabel[planStatus], tone: tone[planStatus] } : {}),
            },
          ];
        })
      : [];
  const display = planItems.length
    ? [
        {
          kind: 'records' as const,
          layout: 'checklist' as const,
          title: '业务计划',
          items: planItems,
        },
      ]
    : sanitizeDisplay(todo?.display);
  return {
    title,
    tone: eventKind === 'plan' ? 'info' : businessTone(status, outcome?.tone),
    detail,
    display,
    evidence,
    showRaw: canShowRawPresentation(gate),
  };
}

type PresentationNormalizer = (source: unknown, gate?: RawPresentationGate) => SharedPresentation;

/** Frozen declarative registry: adding a presentation kind without a presenter is a type error. */
export const SHARED_PRESENTATION_PRESENTERS = Object.freeze({
  tool: selectToolPresentation,
  business_step: selectBusinessStepPresentation,
}) satisfies { [K in SharedPresentationKind]: PresentationNormalizer };

export function listSharedPresentationKinds(): SharedPresentationKind[] {
  return Object.keys(SHARED_PRESENTATION_PRESENTERS) as SharedPresentationKind[];
}

/** Unknown/malformed kinds safely degrade to a closed, raw-free presentation. */
export function selectSharedPresentation(
  input: unknown,
  gate?: RawPresentationGate,
): SharedPresentation {
  const safe = record(boundedSnapshot(input));
  const kind = safe?.kind;
  if (typeof kind === 'string') {
    const presenter = (SHARED_PRESENTATION_PRESENTERS as Record<string, PresentationNormalizer>)[
      kind
    ];
    if (presenter) return presenter(safe?.source, gate);
  }
  return {
    title: '内容不可用',
    tone: 'neutral',
    detail: [],
    display: [],
    evidence: [],
    showRaw: false,
  };
}

/** Alias matching the selector naming used by RenderModel and CardViewModel. */
/** Stable semantic projection for Web/Mobile parity and accessibility scans. */
export function presentationSemanticSignature(presentation: SharedPresentation): string {
  return JSON.stringify({
    title: presentation.title,
    tone: presentation.tone,
    receipt: presentation.receipt,
    detail: presentation.detail,
    display: presentation.display,
    evidence: presentation.evidence,
    showRaw: presentation.showRaw,
  });
}

/**
 * Connects the shared presenter to the existing card contract. Raw summaries/details remain in the
 * card only when the shared three-gate policy authorizes them; closed surfaces are business-only.
 */
export function selectPresentationCardViewModel(
  item: RenderTimelineItem,
  presentation: SharedPresentation,
): CardViewModel {
  const card = selectCardViewModelFromRenderItem(item);
  if (presentation.showRaw) return card;
  const {
    inputSummary: _input,
    outputSummary: _output,
    detail: _detail,
    error: rawError,
    ...safe
  } = card;
  return {
    ...safe,
    title: presentation.title,
    ...(presentation.receipt
      ? { subtitle: `${presentation.receipt.system} · ${presentation.receipt.id}` }
      : {}),
    ...(rawError ? { error: { domain: rawError.domain } } : {}),
    accessibility: {
      ...card.accessibility,
      heading: presentation.title,
      ...(card.outcome
        ? { outcomeLiveAnnouncement: `${presentation.title}${card.outcome.label}` }
        : {}),
    },
  };
}

/** Alias matching the selector naming used by RenderModel and CardViewModel. */
export const selectPresentationViewModel = selectSharedPresentation;
