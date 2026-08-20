/**
 * 右侧企业系统面板的数据契约。
 *
 * 与 ToolPresentation **同源**：同一条工具摘要，detail 渲染进会话流，
 * panel 渲染进右侧面板。面板没有独立数据通道——这是反两套皮的物理约束，
 * 演示剧本能表达的面板 = 真实工具能产出的面板。
 *
 * 面板主体一律走结构化数据 + React 组件渲染（文本经文本节点自动转义），
 * 不走 HTML。理由：iframe 是状态黑洞，要"高亮第 3 行"只能整页重载 srcDoc
 * 或在 iframe 里养第二套渲染器——后者正是本批次要消灭的两套皮。
 * 仅保留一个 `custom` 逃生口，且只接受剧本内嵌来源（见 normalizeSystemPanel）。
 */

/** 统一语义色板。三家客户演示稿逐字相同的 5 档。 */
export type PanelTone = 'pass' | 'warn' | 'deny' | 'info' | 'pending';

export interface PanelBadge {
  text: string;
  tone?: PanelTone;
}

/** 列表行 */
export interface PanelRow {
  /** patch 定位用，必须稳定 */
  id: string;
  /** lucide 图标名，白名单外降级为默认图标 */
  icon?: string;
  text: string;
  sub?: string;
  /** 右起第二列，如文件大小 / 时间 */
  meta?: string;
  badge?: PanelBadge;
  /** normal=常规 excluded=删除线（已剔除） hit=命中高亮 */
  state?: 'normal' | 'excluded' | 'hit';
  tone?: PanelTone;
}

/** 卡片（工单 / 审批 / 事项） */
export interface PanelCard {
  id: string;
  icon?: string;
  title: string;
  /** 标题右推徽章：优先级 / 归属 */
  headBadge?: PanelBadge;
  body?: string;
  /** 底部 meta 徽章：责任人 + 状态 */
  meta?: PanelBadge[];
  /** 审批链节点 */
  steps?: Array<{ label: string; done: boolean }>;
  tone?: PanelTone;
}

export interface PanelCol {
  key: string;
  label: string;
  align?: 'left' | 'right';
  width?: number;
}

export interface PanelTableRow {
  id: string;
  cells: Record<string, string>;
  tone?: PanelTone;
  /** 单元格级标记：colKey → { tone, flag } */
  flags?: Record<string, { tone: PanelTone; flag?: string }>;
}

export interface PanelStat {
  k: string;
  v: string;
  tone?: PanelTone;
}

export interface PanelFeedItem {
  id: string;
  /** 发送者，AI 消息用 "ai" */
  from: string;
  time?: string;
  text: string;
  /** 机器人卡片消息 */
  card?: { title: string; body?: string; meta?: PanelBadge[] };
}

export interface PanelEmpty {
  icon?: string;
  title: string;
  hint?: string;
}

export type PanelWidget =
  | { kind: 'rows'; rows: PanelRow[]; empty?: PanelEmpty; modes?: Array<{ key: string; label: string }>; activeMode?: string }
  | { kind: 'cards'; cards: PanelCard[]; empty?: PanelEmpty }
  | { kind: 'table'; cols: PanelCol[]; rows: PanelTableRow[]; empty?: PanelEmpty }
  | { kind: 'stats'; cols?: 2 | 3 | 4; items: PanelStat[] }
  | { kind: 'feed'; items: PanelFeedItem[]; empty?: PanelEmpty }
  /** 逃生口：仅剧本内嵌可用，来自 transcript 的一律丢弃 */
  | { kind: 'custom'; html: string };

/** 一个 tab = 一个被仿真的企业系统视图 */
export interface PanelView {
  key: string;
  /** tab 上的短标签 */
  label: string;
  /** 拟物窗标题 */
  winTitle: string;
  /** 视图内工具栏：左标题 + 右动态计数 */
  toolbar?: { title: string; sub?: string };
  widget: PanelWidget;
}

export interface SystemPanelSnapshot {
  title?: string;
  /** 标题旁的活动指示点 */
  live?: boolean;
  /** 底部说明，如「已连接：CRM · 制度库」 */
  foot?: string;
  views: PanelView[];
  activeView: string;
}

/**
 * 面板增量。每步一组，运行时 fold：snapshot(n) = patches(0..n).reduce(apply, base)。
 *
 * 刻意**不提供逆运算**——后退一律从 base 重新 fold。客户演示稿实测也是这个做法
 * （手写 reset 函数全量重放），而重新 fold 与会话消息的累加天然同构，后退零额外代码。
 */
export interface PanelPulse {
  op: 'pulse';
  view: string;
  ids: string[];
  kind: 'scan' | 'hit' | 'new';
}

export type PanelPatch =
  | { op: 'focus'; view: string }
  | { op: 'toolbar'; view: string; title?: string; sub?: string }
  | { op: 'rowInsert'; view: string; row: PanelRow; at?: number }
  | { op: 'rowsSet'; view: string; rows: PanelRow[] }
  | { op: 'rowUpdate'; view: string; id: string; set: Partial<Omit<PanelRow, 'id'>> }
  | { op: 'rowsUpdate'; view: string; ids: string[]; set: Partial<Omit<PanelRow, 'id'>> }
  | { op: 'mode'; view: string; mode: string }
  | { op: 'cardInsert'; view: string; card: PanelCard; at?: number }
  | { op: 'cardUpdate'; view: string; id: string; set: Partial<Omit<PanelCard, 'id'>> }
  | { op: 'tableRowInsert'; view: string; row: PanelTableRow; at?: number }
  | { op: 'tableRowUpdate'; view: string; id: string; set: Partial<Omit<PanelTableRow, 'id'>> }
  | { op: 'cellFlag'; view: string; rowId: string; colKey: string; tone: PanelTone; flag?: string }
  | { op: 'statsSet'; view: string; items: PanelStat[] }
  | { op: 'feedAppend'; view: string; item: PanelFeedItem }
  /** 当前步骤的变化集合；不改持久数据，由实时渲染层单独消费。 */
  | PanelPulse;

// ============================================
// 规范化：与 normalizeToolPresentation 同规格——脏数据返回 null，绝不抛错
// ============================================

const PANEL_VIEW_LIMIT = 6;
const PANEL_ROW_LIMIT = 200;
const PANEL_TEXT_LIMIT = 500;
const PANEL_HTML_LIMIT = 200_000;

const TONES = new Set<PanelTone>(['pass', 'warn', 'deny', 'info', 'pending']);
const ROW_STATES = new Set(['normal', 'excluded', 'hit']);

function text(value: unknown, limit = PANEL_TEXT_LIMIT): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

function tone(value: unknown): PanelTone | undefined {
  return typeof value === 'string' && TONES.has(value as PanelTone) ? (value as PanelTone) : undefined;
}

function badge(raw: unknown): PanelBadge | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const label = text(source.text, 60);
  if (label === null) return null;
  const t = tone(source.tone);
  return t ? { text: label, tone: t } : { text: label };
}

function badges(raw: unknown): PanelBadge[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const list = raw.slice(0, 8).map(badge).filter((b): b is PanelBadge => b !== null);
  return list.length ? list : undefined;
}

function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : ({ [key]: value } as Record<string, T>);
}

function row(raw: unknown): PanelRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const id = text(source.id, 120);
  const label = text(source.text);
  if (id === null || label === null) return null;
  const state = typeof source.state === 'string' && ROW_STATES.has(source.state)
    ? (source.state as PanelRow['state'])
    : undefined;
  return {
    id,
    text: label,
    ...optional('icon', text(source.icon, 40) ?? undefined),
    ...optional('sub', text(source.sub) ?? undefined),
    ...optional('meta', text(source.meta, 80) ?? undefined),
    ...optional('badge', badge(source.badge) ?? undefined),
    ...optional('state', state),
    ...optional('tone', tone(source.tone)),
  };
}

function card(raw: unknown): PanelCard | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const id = text(source.id, 120);
  const title = text(source.title);
  if (id === null || title === null) return null;
  const steps = Array.isArray(source.steps)
    ? source.steps
        .slice(0, 12)
        .map((step) => {
          if (!step || typeof step !== 'object') return null;
          const label = text((step as Record<string, unknown>).label, 60);
          if (label === null) return null;
          return { label, done: (step as Record<string, unknown>).done === true };
        })
        .filter((step): step is { label: string; done: boolean } => step !== null)
    : undefined;
  return {
    id,
    title,
    ...optional('icon', text(source.icon, 40) ?? undefined),
    ...optional('headBadge', badge(source.headBadge) ?? undefined),
    ...optional('body', text(source.body, 1000) ?? undefined),
    ...optional('meta', badges(source.meta)),
    ...optional('steps', steps?.length ? steps : undefined),
    ...optional('tone', tone(source.tone)),
  };
}

function tableRow(raw: unknown): PanelTableRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const id = text(source.id, 120);
  if (id === null) return null;
  const cells: Record<string, string> = {};
  if (source.cells && typeof source.cells === 'object') {
    for (const [key, value] of Object.entries(source.cells as Record<string, unknown>)) {
      const cell = text(value, 200);
      if (cell !== null) cells[key] = cell;
    }
  }
  const flags: Record<string, { tone: PanelTone; flag?: string }> = {};
  if (source.flags && typeof source.flags === 'object') {
    for (const [key, value] of Object.entries(source.flags as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const t = tone((value as Record<string, unknown>).tone);
      if (!t) continue;
      const flag = text((value as Record<string, unknown>).flag, 40);
      flags[key] = flag === null ? { tone: t } : { tone: t, flag };
    }
  }
  return {
    id,
    cells,
    ...optional('tone', tone(source.tone)),
    ...(Object.keys(flags).length ? { flags } : {}),
  };
}

function feedItem(raw: unknown): PanelFeedItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const id = text(source.id, 120);
  const from = text(source.from, 60);
  const body = text(source.text, 1000);
  if (id === null || from === null || body === null) return null;
  let cardPayload: PanelFeedItem['card'];
  if (source.card && typeof source.card === 'object') {
    const rawCard = source.card as Record<string, unknown>;
    const title = text(rawCard.title, 120);
    if (title !== null) {
      cardPayload = {
        title,
        ...optional('body', text(rawCard.body, 600) ?? undefined),
        ...optional('meta', badges(rawCard.meta)),
      };
    }
  }
  return {
    id,
    from,
    text: body,
    ...optional('time', text(source.time, 40) ?? undefined),
    ...optional('card', cardPayload),
  };
}

function empty(raw: unknown): PanelEmpty | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const source = raw as Record<string, unknown>;
  const title = text(source.title, 120);
  if (title === null) return undefined;
  return {
    title,
    ...optional('icon', text(source.icon, 40) ?? undefined),
    ...optional('hint', text(source.hint, 200) ?? undefined),
  };
}

function widget(raw: unknown, allowCustomHtml: boolean): PanelWidget | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  switch (source.kind) {
    case 'rows': {
      const rows = Array.isArray(source.rows)
        ? source.rows.slice(0, PANEL_ROW_LIMIT).map(row).filter((r): r is PanelRow => r !== null)
        : [];
      const modes = Array.isArray(source.modes)
        ? source.modes
            .slice(0, 6)
            .map((mode) => {
              if (!mode || typeof mode !== 'object') return null;
              const key = text((mode as Record<string, unknown>).key, 40);
              const label = text((mode as Record<string, unknown>).label, 40);
              return key && label ? { key, label } : null;
            })
            .filter((mode): mode is { key: string; label: string } => mode !== null)
        : undefined;
      return {
        kind: 'rows',
        rows,
        ...optional('empty', empty(source.empty)),
        ...optional('modes', modes?.length ? modes : undefined),
        ...optional('activeMode', text(source.activeMode, 40) ?? undefined),
      };
    }
    case 'cards':
      return {
        kind: 'cards',
        cards: Array.isArray(source.cards)
          ? source.cards.slice(0, PANEL_ROW_LIMIT).map(card).filter((c): c is PanelCard => c !== null)
          : [],
        ...optional('empty', empty(source.empty)),
      };
    case 'table': {
      const cols = Array.isArray(source.cols)
        ? source.cols
            .slice(0, 12)
            .map((col) => {
              if (!col || typeof col !== 'object') return null;
              const key = text((col as Record<string, unknown>).key, 40);
              const label = text((col as Record<string, unknown>).label, 60);
              if (key === null || label === null) return null;
              const align = (col as Record<string, unknown>).align;
              const width = (col as Record<string, unknown>).width;
              return {
                key,
                label,
                ...(align === 'right' || align === 'left' ? { align } : {}),
                ...(typeof width === 'number' && Number.isFinite(width) ? { width } : {}),
              } as PanelCol;
            })
            .filter((col): col is PanelCol => col !== null)
        : [];
      return {
        kind: 'table',
        cols,
        rows: Array.isArray(source.rows)
          ? source.rows.slice(0, PANEL_ROW_LIMIT).map(tableRow).filter((r): r is PanelTableRow => r !== null)
          : [],
        ...optional('empty', empty(source.empty)),
      };
    }
    case 'stats': {
      const items = Array.isArray(source.items)
        ? source.items
            .slice(0, 12)
            .map((item) => {
              if (!item || typeof item !== 'object') return null;
              const k = text((item as Record<string, unknown>).k, 60);
              const v = text((item as Record<string, unknown>).v, 60);
              if (k === null || v === null) return null;
              return { k, v, ...optional('tone', tone((item as Record<string, unknown>).tone)) };
            })
            .filter((item): item is PanelStat => item !== null)
        : [];
      const cols = source.cols;
      return {
        kind: 'stats',
        items,
        ...(cols === 2 || cols === 3 || cols === 4 ? { cols } : {}),
      };
    }
    case 'feed':
      return {
        kind: 'feed',
        items: Array.isArray(source.items)
          ? source.items.slice(0, PANEL_ROW_LIMIT).map(feedItem).filter((i): i is PanelFeedItem => i !== null)
          : [],
        ...optional('empty', empty(source.empty)),
      };
    case 'custom': {
      // 安全硬线：来自 transcript 的 custom 一律丢弃并降级为空视图。
      // 工具产出的 HTML 走既有 [FILE] 产物卡通道，不进面板。
      if (!allowCustomHtml) return { kind: 'rows', rows: [], empty: { title: '内容不可用' } };
      const html = text(source.html, PANEL_HTML_LIMIT);
      return html === null ? null : { kind: 'custom', html };
    }
    default:
      return null;
  }
}

function view(raw: unknown, allowCustomHtml: boolean): PanelView | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const key = text(source.key, 60);
  const label = text(source.label, 40);
  const winTitle = text(source.winTitle, 120);
  if (key === null || label === null || winTitle === null) return null;
  const body = widget(source.widget, allowCustomHtml);
  if (!body) return null;
  let toolbar: PanelView['toolbar'];
  if (source.toolbar && typeof source.toolbar === 'object') {
    const rawToolbar = source.toolbar as Record<string, unknown>;
    const title = text(rawToolbar.title, 120);
    if (title !== null) toolbar = { title, ...optional('sub', text(rawToolbar.sub, 120) ?? undefined) };
  }
  return { key, label, winTitle, widget: body, ...optional('toolbar', toolbar) };
}

/**
 * 规范化面板底稿。
 *
 * @param allowCustomHtml 仅演示剧本内嵌来源可传 true；解析 transcript 时必须为 false。
 */
export function normalizeSystemPanel(raw: unknown, allowCustomHtml = false): SystemPanelSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  if (!Array.isArray(source.views)) return null;
  const views = source.views
    .slice(0, PANEL_VIEW_LIMIT)
    .map((item) => view(item, allowCustomHtml))
    .filter((item): item is PanelView => item !== null);
  if (!views.length) return null;
  const requested = text(source.activeView, 60);
  const activeView = requested && views.some((v) => v.key === requested) ? requested : views[0].key;
  return {
    views,
    activeView,
    ...optional('title', text(source.title, 80) ?? undefined),
    ...(source.live === true ? { live: true } : {}),
    ...optional('foot', text(source.foot, 200) ?? undefined),
  };
}

const PATCH_OPS = new Set([
  'focus', 'toolbar', 'rowInsert', 'rowsSet', 'rowUpdate', 'rowsUpdate', 'mode',
  'cardInsert', 'cardUpdate', 'tableRowInsert', 'tableRowUpdate',
  'cellFlag', 'statsSet', 'feedAppend', 'pulse',
]);

function patch(raw: unknown): PanelPatch | null {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw as Record<string, unknown>;
  const op = source.op;
  if (typeof op !== 'string' || !PATCH_OPS.has(op)) return null;
  const viewKey = text(source.view, 60);
  if (op !== 'focus' && viewKey === null) return null;

  switch (op) {
    case 'focus': {
      const target = text(source.view, 60);
      return target === null ? null : { op: 'focus', view: target };
    }
    case 'toolbar':
      return {
        op: 'toolbar',
        view: viewKey!,
        ...optional('title', text(source.title, 120) ?? undefined),
        ...optional('sub', text(source.sub, 120) ?? undefined),
      };
    case 'rowInsert': {
      const value = row(source.row);
      if (!value) return null;
      return {
        op: 'rowInsert',
        view: viewKey!,
        row: value,
        ...(typeof source.at === 'number' && Number.isFinite(source.at) ? { at: Math.trunc(source.at) } : {}),
      };
    }
    case 'rowsSet': {
      if (!Array.isArray(source.rows)) return null;
      const rows = source.rows
        .slice(0, PANEL_ROW_LIMIT)
        .map((item) => row(item))
        .filter((item): item is PanelRow => item !== null);
      return { op: 'rowsSet', view: viewKey!, rows };
    }
    case 'rowUpdate': {
      const id = text(source.id, 120);
      if (id === null || !source.set || typeof source.set !== 'object') return null;
      const set = row({ id, text: 'x', ...(source.set as object) });
      if (!set) return null;
      const { id: _ignored, text: _text, ...rest } = set;
      const patched = (source.set as Record<string, unknown>).text !== undefined
        ? { ...rest, text: set.text }
        : rest;
      return { op: 'rowUpdate', view: viewKey!, id, set: patched };
    }
    case 'rowsUpdate': {
      const ids = Array.isArray(source.ids)
        ? source.ids.map((id) => text(id, 120)).filter((id): id is string => id !== null)
        : [];
      if (!ids.length || !source.set || typeof source.set !== 'object') return null;
      const set = row({ id: 'x', text: 'x', ...(source.set as object) });
      if (!set) return null;
      const { id: _ignored, text: _text, ...rest } = set;
      const patched = (source.set as Record<string, unknown>).text !== undefined
        ? { ...rest, text: set.text }
        : rest;
      return { op: 'rowsUpdate', view: viewKey!, ids, set: patched };
    }
    case 'mode': {
      const mode = text(source.mode, 40);
      return mode === null ? null : { op: 'mode', view: viewKey!, mode };
    }
    case 'cardInsert': {
      const value = card(source.card);
      if (!value) return null;
      return {
        op: 'cardInsert',
        view: viewKey!,
        card: value,
        ...(typeof source.at === 'number' && Number.isFinite(source.at) ? { at: Math.trunc(source.at) } : {}),
      };
    }
    case 'cardUpdate': {
      const id = text(source.id, 120);
      if (id === null || !source.set || typeof source.set !== 'object') return null;
      const set = card({ id, title: 'x', ...(source.set as object) });
      if (!set) return null;
      const { id: _ignored, title: _title, ...rest } = set;
      const patched = (source.set as Record<string, unknown>).title !== undefined
        ? { ...rest, title: set.title }
        : rest;
      return { op: 'cardUpdate', view: viewKey!, id, set: patched };
    }
    case 'tableRowInsert': {
      const value = tableRow(source.row);
      if (!value) return null;
      return {
        op: 'tableRowInsert',
        view: viewKey!,
        row: value,
        ...(typeof source.at === 'number' && Number.isFinite(source.at) ? { at: Math.trunc(source.at) } : {}),
      };
    }
    case 'tableRowUpdate': {
      const id = text(source.id, 120);
      if (id === null || !source.set || typeof source.set !== 'object') return null;
      const set = tableRow({ id, ...(source.set as object) });
      if (!set) return null;
      const { id: _ignored, ...rest } = set;
      return { op: 'tableRowUpdate', view: viewKey!, id, set: rest };
    }
    case 'cellFlag': {
      const rowId = text(source.rowId, 120);
      const colKey = text(source.colKey, 40);
      const t = tone(source.tone);
      if (rowId === null || colKey === null || !t) return null;
      return {
        op: 'cellFlag',
        view: viewKey!,
        rowId,
        colKey,
        tone: t,
        ...optional('flag', text(source.flag, 40) ?? undefined),
      };
    }
    case 'statsSet': {
      const parsed = widget({ kind: 'stats', items: source.items }, false);
      if (!parsed || parsed.kind !== 'stats') return null;
      return { op: 'statsSet', view: viewKey!, items: parsed.items };
    }
    case 'feedAppend': {
      const item = feedItem(source.item);
      return item === null ? null : { op: 'feedAppend', view: viewKey!, item };
    }
    case 'pulse': {
      const ids = Array.isArray(source.ids)
        ? source.ids.map((id) => text(id, 120)).filter((id): id is string => id !== null)
        : [];
      const kind = source.kind;
      if (kind !== 'scan' && kind !== 'hit' && kind !== 'new') return null;
      return { op: 'pulse', view: viewKey!, ids, kind };
    }
    default:
      return null;
  }
}

export function normalizePanelPatches(raw: unknown): PanelPatch[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, PANEL_ROW_LIMIT).map(patch).filter((item): item is PanelPatch => item !== null);
}

// ============================================
// fold：纯函数，不可变
// ============================================

function mapView(snapshot: SystemPanelSnapshot, key: string, fn: (view: PanelView) => PanelView): SystemPanelSnapshot {
  let changed = false;
  const views = snapshot.views.map((item) => {
    if (item.key !== key) return item;
    changed = true;
    return fn(item);
  });
  return changed ? { ...snapshot, views } : snapshot;
}

function insertAt<T>(list: T[], item: T, at?: number): T[] {
  if (at === undefined || at < 0 || at >= list.length) return [...list, item];
  return [...list.slice(0, at), item, ...list.slice(at)];
}

function applyPatch(snapshot: SystemPanelSnapshot, p: PanelPatch): SystemPanelSnapshot {
  switch (p.op) {
    // 瞬时动效不改数据
    case 'pulse':
      return snapshot;
    case 'focus':
      return snapshot.views.some((v) => v.key === p.view) ? { ...snapshot, activeView: p.view } : snapshot;
    case 'toolbar':
      return mapView(snapshot, p.view, (view) => ({
        ...view,
        toolbar: {
          title: p.title ?? view.toolbar?.title ?? view.winTitle,
          ...optional('sub', p.sub ?? view.toolbar?.sub),
        },
      }));
    case 'rowInsert':
      return mapView(snapshot, p.view, (view) =>
        view.widget.kind === 'rows'
          ? { ...view, widget: { ...view.widget, rows: insertAt(view.widget.rows, p.row, p.at) } }
          : view);
    case 'rowsSet':
      return mapView(snapshot, p.view, (view) =>
        view.widget.kind === 'rows'
          ? { ...view, widget: { ...view.widget, rows: p.rows.map((row) => ({ ...row })) } }
          : view);
    case 'rowUpdate':
      return mapView(snapshot, p.view, (view) =>
        view.widget.kind === 'rows'
          ? { ...view, widget: { ...view.widget, rows: view.widget.rows.map((r) => (r.id === p.id ? { ...r, ...p.set } : r)) } }
          : view);
    case 'rowsUpdate': {
      const ids = new Set(p.ids);
      return mapView(snapshot, p.view, (view) =>
        view.widget.kind === 'rows'
          ? { ...view, widget: { ...view.widget, rows: view.widget.rows.map((r) => (ids.has(r.id) ? { ...r, ...p.set } : r)) } }
          : view);
    }
    case 'mode':
      return mapView(snapshot, p.view, (view) =>
        view.widget.kind === 'rows' ? { ...view, widget: { ...view.widget, activeMode: p.mode } } : view);
    case 'cardInsert':
      return mapView(snapshot, p.view, (view) =>
        view.widget.kind === 'cards'
          ? { ...view, widget: { ...view.widget, cards: insertAt(view.widget.cards, p.card, p.at) } }
          : view);
    case 'cardUpdate':
      return mapView(snapshot, p.view, (view) =>
        view.widget.kind === 'cards'
          ? { ...view, widget: { ...view.widget, cards: view.widget.cards.map((c) => (c.id === p.id ? { ...c, ...p.set } : c)) } }
          : view);
    case 'tableRowInsert':
      return mapView(snapshot, p.view, (view) =>
        view.widget.kind === 'table'
          ? { ...view, widget: { ...view.widget, rows: insertAt(view.widget.rows, p.row, p.at) } }
          : view);
    case 'tableRowUpdate':
      return mapView(snapshot, p.view, (view) =>
        view.widget.kind === 'table'
          ? {
              ...view,
              widget: {
                ...view.widget,
                rows: view.widget.rows.map((r) => r.id === p.id ? {
                  ...r,
                  ...p.set,
                  ...(p.set.cells ? { cells: { ...r.cells, ...p.set.cells } } : {}),
                  ...(p.set.flags ? { flags: { ...r.flags, ...p.set.flags } } : {}),
                } : r),
              },
            }
          : view);
    case 'cellFlag':
      return mapView(snapshot, p.view, (view) =>
        view.widget.kind === 'table'
          ? {
              ...view,
              widget: {
                ...view.widget,
                rows: view.widget.rows.map((r) =>
                  r.id === p.rowId
                    ? { ...r, flags: { ...r.flags, [p.colKey]: { tone: p.tone, ...optional('flag', p.flag) } } }
                    : r),
              },
            }
          : view);
    case 'statsSet':
      return mapView(snapshot, p.view, (view) =>
        view.widget.kind === 'stats' ? { ...view, widget: { ...view.widget, items: p.items } } : view);
    case 'feedAppend':
      return mapView(snapshot, p.view, (view) =>
        view.widget.kind === 'feed' ? { ...view, widget: { ...view.widget, items: [...view.widget.items, p.item] } } : view);
    default:
      return snapshot;
  }
}

/** 纯函数。pulse 被忽略（只在实时推进时喂给动效层）。 */
export function foldPanel(base: SystemPanelSnapshot, patches: PanelPatch[]): SystemPanelSnapshot {
  return patches.reduce(applyPatch, base);
}
