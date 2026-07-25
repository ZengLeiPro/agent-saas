import { clampText, normalizeDetailLine, type DetailLine } from '../toolPresentation';
import type {
  BlockAction,
  CalloutBlock,
  GateBlock,
  PresentationBlock,
  PresentationBlockKind,
  RecordItem,
  RecordsBlock,
  PresentationTone,
} from './types';

/**
 * 呈现块的归一层注册表（跨端共用）。
 *
 * 与 `normalizeToolPresentation` 同一套哲学：**一律返回 null 而非抛错**，
 * 渲染层永不因脏数据崩；未知 kind 静默丢弃，使旧客户端读到新快照不崩——
 * 这是分享链路的前后兼容红线。
 */

const TONES = new Set<PresentationTone>(['neutral', 'info', 'success', 'warn', 'danger', 'muted']);
const ACTION_KINDS = new Set(['primary', 'warning', 'danger', 'ghost', 'copy', 'link']);
const LAYOUTS = new Set(['rows', 'grid', 'checklist']);

const DISPLAY_BLOCK_LIMIT = 40;
const BODY_LINE_LIMIT = 20;
const ITEM_LIMIT = 100;
const ACTION_LIMIT = 4;
const DETAIL_LIMIT = 60;

function tone(value: unknown): PresentationTone | undefined {
  return typeof value === 'string' && TONES.has(value as PresentationTone) ? (value as PresentationTone) : undefined;
}

function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : ({ [key]: value } as Record<string, T>);
}

function body(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    const single = clampText(raw);
    return single === null ? [] : [single];
  }
  return raw
    .slice(0, BODY_LINE_LIMIT)
    .map(clampText)
    .filter((line): line is string => line !== null);
}

function detail(raw: unknown): DetailLine[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const lines = raw
    .slice(0, DETAIL_LIMIT)
    .map(normalizeDetailLine)
    .filter((line): line is DetailLine => line !== null);
  return lines.length ? lines : undefined;
}

function action(raw: unknown): BlockAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const label = clampText(source.label);
  const kind = source.kind;
  if (label === null || typeof kind !== 'string' || !ACTION_KINDS.has(kind)) return null;
  return {
    kind: kind as BlockAction['kind'],
    label,
    ...optional('href', clampText(source.href) ?? undefined),
    ...optional('copyText', clampText(source.copyText) ?? undefined),
    ...optional('interactionId', clampText(source.interactionId) ?? undefined),
  };
}

function actions(raw: unknown): BlockAction[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const list = raw.slice(0, ACTION_LIMIT).map(action).filter((item): item is BlockAction => item !== null);
  return list.length ? list : undefined;
}

function recordItem(raw: unknown): RecordItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const label = clampText(source.label);
  if (label === null) return null;

  let tag: RecordItem['tag'];
  if (source.tag && typeof source.tag === 'object') {
    const rawTag = source.tag as Record<string, unknown>;
    const text = clampText(rawTag.text);
    if (text !== null) tag = { tone: tone(rawTag.tone) ?? 'neutral', text };
  }

  return {
    label,
    ...optional('value', clampText(source.value) ?? undefined),
    ...optional('tag', tag),
    ...optional('note', clampText(source.note) ?? undefined),
    ...optional('tone', tone(source.tone)),
    ...optional('detail', detail(source.detail)),
    ...(source.mono === true ? { mono: true } : {}),
  };
}

function normalizeCallout(raw: Record<string, unknown>): CalloutBlock | null {
  const lines = body(raw.body);
  const detailLines = detail(raw.detail);
  // 正文与依据行同时为空的卡片没有信息量，丢弃而不是渲染一个空壳
  if (!lines.length && !detailLines) return null;
  return {
    kind: 'callout',
    tone: tone(raw.tone) ?? 'neutral',
    body: lines,
    ...optional('title', clampText(raw.title) ?? undefined),
    ...optional('detail', detailLines),
    ...(raw.collapsible === true ? { collapsible: true } : {}),
    ...(raw.defaultOpen === true ? { defaultOpen: true } : {}),
    ...optional('actions', actions(raw.actions)),
  };
}

function normalizeRecords(raw: Record<string, unknown>): RecordsBlock | null {
  const items = Array.isArray(raw.items)
    ? raw.items.slice(0, ITEM_LIMIT).map(recordItem).filter((item): item is RecordItem => item !== null)
    : [];
  if (!items.length) return null;
  const layout = typeof raw.layout === 'string' && LAYOUTS.has(raw.layout)
    ? (raw.layout as RecordsBlock['layout'])
    : 'rows';
  return {
    kind: 'records',
    layout,
    items,
    ...optional('title', clampText(raw.title) ?? undefined),
    ...optional('footer', clampText(raw.footer) ?? undefined),
    ...optional('actions', actions(raw.actions)),
  };
}

function normalizeGate(raw: Record<string, unknown>): GateBlock | null {
  const title = clampText(raw.title);
  const list = actions(raw.actions);
  // 没有动作的门禁不是门禁——它是 callout，不允许伪装
  if (title === null || !list) return null;
  const meta = Array.isArray(raw.meta)
    ? raw.meta
        .slice(0, 12)
        .map((entry) => {
          if (!entry || typeof entry !== 'object') return null;
          const k = clampText((entry as Record<string, unknown>).k);
          const v = clampText((entry as Record<string, unknown>).v);
          return k === null ? null : { k, v: v ?? '' };
        })
        .filter((entry): entry is { k: string; v: string } => entry !== null)
    : undefined;
  return {
    kind: 'gate',
    title,
    actions: list,
    ...(body(raw.body).length ? { body: body(raw.body) } : {}),
    ...optional('meta', meta?.length ? meta : undefined),
  };
}

type Normalizer<K extends PresentationBlockKind> =
  (raw: Record<string, unknown>) => Extract<PresentationBlock, { kind: K }> | null;

/**
 * 声明式注册表。
 *
 * 刻意用冻结的对象字面量而非 `registry.set()` 副作用注册：
 * ① Vite HMR 下副作用注册会重复执行；
 * ② 副作用注册依赖「注册文件被 import 过」，tree-shaking 会静默吃掉未被引用
 *    的注册，表现为「块在生产环境消失」——这类 bug 极难定位。
 *
 * `satisfies` 的映射类型是穷尽性契约：往联合里加了 kind 却忘了注册，
 * 这里直接编译报错。
 */
export const BLOCK_NORMALIZERS = Object.freeze({
  callout: normalizeCallout,
  records: normalizeRecords,
  gate: normalizeGate,
}) satisfies { [K in PresentationBlockKind]: Normalizer<K> };

/** 归一不可信来源（transcript / 演示剧本 / 未来的工具产出）。永不抛错。 */
export function normalizeDisplay(raw: unknown): PresentationBlock[] | null {
  if (!Array.isArray(raw)) return null;
  const out: PresentationBlock[] = [];
  for (const item of raw.slice(0, DISPLAY_BLOCK_LIMIT)) {
    if (!item || typeof item !== 'object') continue;
    const kind = (item as { kind?: unknown }).kind;
    if (typeof kind !== 'string') continue;
    const normalize = (BLOCK_NORMALIZERS as Record<string, Normalizer<PresentationBlockKind>>)[kind];
    // 未知 kind 静默丢弃：旧客户端读到新快照不崩，是分享链路的前后兼容红线
    if (!normalize) continue;
    const block = normalize(item as Record<string, unknown>);
    if (block) out.push(block);
  }
  return out.length ? out : null;
}

/** 供覆盖率/穷尽性测试使用 */
export function listBlockKinds(): PresentationBlockKind[] {
  return Object.keys(BLOCK_NORMALIZERS) as PresentationBlockKind[];
}
