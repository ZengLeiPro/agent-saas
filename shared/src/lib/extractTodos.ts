import type { MessageItem } from "../types/message";
import { normalizeDetailLine, type DetailLine } from "./toolPresentation";
import { normalizeDisplay } from "./presentation/registry";
import type { PresentationBlock } from "./presentation/types";

export type TodoStatus =
  | "pending"
  | "in_progress"
  | "waiting"
  | "blocked"
  | "completed"
  | "failed";

/**
 * 一句话业务结果/现状。折叠视图里步骤只剩标题一行时，它是唯一的信息位：
 * - text：业务结论（「17/18 通过，1 张退回」「等财务审批，截止明午」）；
 * - tone：修正折叠行语义色——completed+warn = 完成但有例外，不允许干净绿勾掩盖；
 * - stat：分流计数徽标（一致 61 / 差异 19 / 无法匹配 6）。
 */
export interface TodoOutcome {
  text: string;
  tone?: "ok" | "warn" | "fail";
  stat?: Array<{ label: string; value: string }>;
}

export interface TodoItem {
  /** 稳定业务步骤 ID；历史 TodoWrite 快照可以不带。 */
  id?: string;
  /** 新调用只生成 business；task/undefined 仅用于解析历史快照。 */
  kind?: "task" | "business";
  content: string;
  status: TodoStatus;
  activeForm?: string;
  outcome?: TodoOutcome;
  detail?: DetailLine[];
  /** 新调用提交语义展示块；读取侧统一归一为无交互 PresentationBlock。 */
  display?: PresentationBlock[];
  /** 引用真实事实、对象或回执的稳定标识。 */
  evidenceRefs?: string[];
}

const TODO_WRITE_TOOL_NAME = "TodoWrite";
const TODO_DETAIL_LIMIT = 60;
const TODO_EVIDENCE_LIMIT = 20;
const TODO_OUTCOME_TEXT_LIMIT = 120;
const TODO_OUTCOME_STAT_LIMIT = 6;

function isTodoStatus(status: unknown): status is TodoStatus {
  return status === "pending"
    || status === "in_progress"
    || status === "waiting"
    || status === "blocked"
    || status === "completed"
    || status === "failed";
}

function text(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

const TODO_DISPLAY_LIMIT = 40;
const TODO_FACTS_GRID_MIN = 3;
const TODO_FACTS_GRID_MAX = 12;
const TODO_FACT_LABEL_GRID_LIMIT = 16;
const TODO_FACT_VALUE_GRID_LIMIT = 40;

const CHECKLIST_TONE = {
  pass: "success",
  fail: "danger",
  warn: "warn",
  pending: "muted",
} as const;

type SemanticDisplayType = "facts" | "list" | "comparison" | "checklist";

function isSemanticDisplayType(value: unknown): value is SemanticDisplayType {
  return value === "facts" || value === "list" || value === "comparison" || value === "checklist";
}

function semanticRecordItem(raw: unknown, type: SemanticDisplayType): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  if (typeof source.label !== "string" || !source.label.trim()) return null;
  if (type === "facts" && (typeof source.value !== "string" || !source.value.trim())) return null;

  const comparisonFields = [source.baseline, source.current, source.delta];
  const hasComparisonFields = comparisonFields.some((value) => value !== undefined);
  if (type === "comparison" && hasComparisonFields && !comparisonFields.every((value) => typeof value === "string" && value.trim())) {
    return null;
  }

  let tone: (typeof CHECKLIST_TONE)[keyof typeof CHECKLIST_TONE] | undefined;
  if (type === "checklist") {
    if (!(source.status === "pass" || source.status === "fail" || source.status === "warn" || source.status === "pending")) {
      return null;
    }
    tone = CHECKLIST_TONE[source.status];
  } else if (type === "comparison" && (source.status === "pass" || source.status === "fail" || source.status === "warn" || source.status === "pending")) {
    tone = CHECKLIST_TONE[source.status];
  }

  return {
    label: source.label,
    ...(source.value !== undefined ? { value: source.value } : {}),
    ...(type === "comparison" && hasComparisonFields ? {
      baseline: source.baseline,
      current: source.current,
      delta: source.delta,
    } : {}),
    ...(type !== "facts" && source.note !== undefined ? { note: source.note } : {}),
    ...(type !== "facts" && source.detail !== undefined ? { detail: source.detail } : {}),
    ...(tone ? { tone } : {}),
  };
}

function factsFitGrid(block: Extract<PresentationBlock, { kind: "records" }>): boolean {
  return block.items.length >= TODO_FACTS_GRID_MIN
    && block.items.length <= TODO_FACTS_GRID_MAX
    && block.items.every((item) => {
      const value = item.value ?? "";
      return !!value
        && !item.tag
        && !item.note
        && !item.detail?.length
        && !item.tone
        && !item.label.includes("\n")
        && !value.includes("\n")
        && item.label.length <= TODO_FACT_LABEL_GRID_LIMIT
        && value.length <= TODO_FACT_VALUE_GRID_LIMIT;
    });
}

function normalizeSemanticTodoBlock(raw: Record<string, unknown>): PresentationBlock | null {
  const type = raw.type;
  if (!isSemanticDisplayType(type)) return null;
  if (typeof raw.title !== "string" || !raw.title.trim() || !Array.isArray(raw.items)) return null;

  const items = raw.items
    .map((item) => semanticRecordItem(item, type))
    .filter((item): item is Record<string, unknown> => item !== null);
  if (!items.length) return null;

  const comparisonReady = type === "comparison"
    && items.every((item) => item.baseline !== undefined && item.current !== undefined && item.delta !== undefined);
  const normalized = normalizeDisplay([{
    kind: "records",
    layout: type === "checklist" ? "checklist" : comparisonReady ? "comparison" : "rows",
    title: raw.title,
    items,
    ...(raw.footer !== undefined ? { footer: raw.footer } : {}),
  }])?.[0];
  if (!normalized || normalized.kind !== "records") return null;

  if (type === "facts" && factsFitGrid(normalized)) {
    return { ...normalized, layout: "grid" };
  }
  return normalized;
}

function stripTodoBlockActions(block: PresentationBlock): PresentationBlock | null {
  // Todo 只负责展示业务步骤。需要回写的 gate 必须绑定真实 ask_user / permission 流程，
  // 不能让一段 TodoWrite 入参凭空制造可点击审批。
  if (block.kind === "gate") return null;
  const { actions: _actions, ...safeBlock } = block;
  return safeBlock;
}

export function normalizeTodoDisplay(raw: unknown): PresentationBlock[] | undefined {
  if (!Array.isArray(raw)) return undefined;

  const blocks = raw.slice(0, TODO_DISPLAY_LIMIT).flatMap((item): PresentationBlock[] => {
    if (!item || typeof item !== "object") return [];
    const source = item as Record<string, unknown>;

    // 历史 transcript 只读兼容优先：旧块可能带未知扩展字段，不能因碰巧存在 type 就误删。
    if (source.kind === "callout" || source.kind === "records" || source.kind === "gate") {
      const legacy = normalizeDisplay([source])?.[0];
      return legacy ? [legacy] : [];
    }

    // 新 Tool 协议：Agent 只提交业务语义，shared 在进入渲染层前确定布局。
    if (isSemanticDisplayType(source.type)) {
      const block = normalizeSemanticTodoBlock(source);
      return block ? [block] : [];
    }
    return [];
  });

  const safeBlocks = blocks
    .map(stripTodoBlockActions)
    .filter((block): block is PresentationBlock => block !== null);
  return safeBlocks.length ? safeBlocks : undefined;
}

function normalizeTodoOutcome(raw: unknown): TodoOutcome | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const outcome = raw as Record<string, unknown>;
  const outcomeText = text(outcome.text, TODO_OUTCOME_TEXT_LIMIT);
  if (!outcomeText) return undefined;

  const tone = outcome.tone === "ok" || outcome.tone === "warn" || outcome.tone === "fail"
    ? outcome.tone
    : undefined;

  const stat = Array.isArray(outcome.stat)
    ? outcome.stat
      .slice(0, TODO_OUTCOME_STAT_LIMIT)
      .flatMap((item): Array<{ label: string; value: string }> => {
        if (!item || typeof item !== "object") return [];
        const entry = item as Record<string, unknown>;
        const label = text(entry.label, 20);
        const value = text(entry.value, 40);
        return label && value ? [{ label, value }] : [];
      })
    : [];

  return {
    text: outcomeText,
    ...(tone ? { tone } : {}),
    ...(stat.length ? { stat } : {}),
  };
}

function normalizeTodoItem(raw: unknown): TodoItem | null {
  if (!raw || typeof raw !== "object") return null;
  const todo = raw as Record<string, unknown>;
  const content = text(todo.content, 500);
  if (!content || !isTodoStatus(todo.status)) return null;

  const id = text(todo.id, 100);
  const activeForm = text(todo.activeForm, 500);
  const kind = todo.kind === "business" || todo.kind === "task" ? todo.kind : undefined;
  const outcome = normalizeTodoOutcome(todo.outcome);

  const detail = Array.isArray(todo.detail)
    ? todo.detail
      .slice(0, TODO_DETAIL_LIMIT)
      .map(normalizeDetailLine)
      .filter((line): line is DetailLine => line !== null)
    : [];

  const evidenceRefs = Array.isArray(todo.evidenceRefs)
    ? todo.evidenceRefs
      .slice(0, TODO_EVIDENCE_LIMIT)
      .map((item) => text(item, 200))
      .filter((item): item is string => !!item)
    : [];

  const display = normalizeTodoDisplay(todo.display);

  return {
    ...(id ? { id } : {}),
    ...(kind ? { kind } : {}),
    content,
    status: todo.status,
    ...(activeForm ? { activeForm } : {}),
    ...(outcome ? { outcome } : {}),
    ...(detail.length ? { detail } : {}),
    ...(display ? { display } : {}),
    ...(evidenceRefs.length ? { evidenceRefs } : {}),
  };
}

/**
 * Returns undefined when the input is not a complete TodoWrite payload yet.
 * Returns null when a complete payload explicitly means "no todos".
 */
export function parseTodos(toolInput: string): TodoItem[] | null | undefined {
  if (!toolInput.trim()) return undefined;

  try {
    const parsed = JSON.parse(toolInput) as { todos?: unknown };
    if (!Array.isArray(parsed?.todos)) return undefined;
    if (parsed.todos.length === 0) return null;

    const todos = parsed.todos
      .map(normalizeTodoItem)
      .filter((todo): todo is TodoItem => todo !== null);

    return todos.length > 0 ? todos : null;
  } catch {
    return undefined;
  }
}

export function todoItemKey(todo: TodoItem): string {
  return todo.id ? `id:${todo.id}` : `legacy:${todo.content}`;
}

export function isBusinessTodo(todo: TodoItem): boolean {
  return todo.kind === "business";
}

// ---------------------------------------------------------------------------
// 业务步骤事件流投影
// ---------------------------------------------------------------------------
//
// 设计原则（对齐场景 demo 的时间线性叙事，替代 08-02 的「原地更新看板」形态）：
// - TodoWrite 是全量快照替换语义；快照本身不直接渲染，而是对相邻快照做**差分**，
//   把每个状态转移变成一条会话流内的事件，出现在它发生的时间位置。
// - 普通工具调用不再被吸进步骤卡：thinking / 工具活动 / 正文保持自然时间顺序，
//   与业务事件同向线性生长，杜绝「活动跳回上方卡片、正文在下方脱节」的撕裂。
// - 计划与步骤状态只在会话流内呈现，不再额外投影到输入框上方。
// - 投影是纯函数、无累积状态：同一输入永远产出同一事件序列（React 重渲染幂等）。

export type BusinessStepEventKind =
  | "plan"
  | "start"
  | "complete"
  | "fail"
  | "block"
  | "wait"
  | "update"
  | "reset";

export interface BusinessStepEventItem {
  type: "business_step";
  /** 由 anchor 消息 id + 步骤 key + 事件种类构成，天然稳定、幂等。 */
  id: string;
  /** 产生本事件的 TodoWrite 消息 id，决定事件在会话流中的位置。 */
  anchorMessageId: string;
  /** 业务 Run 身份；用于历史前插后安全重映射详情选择，不参与 TodoWrite schema。 */
  runId?: string;
  kind: BusinessStepEventKind;
  /** step 事件（start/complete/fail/block/wait）：事件发生时该步骤的快照内容。 */
  todo?: TodoItem;
  /** plan 事件：当时的完整业务步骤列表。 */
  todos?: TodoItem[];
  /** 1-based 序号（step 事件）。 */
  stepIndex?: number;
  stepCount?: number;
  /** 最新快照的当前进行步骤且 run 仍活跃：渲染层据此显示 spinner。 */
  isCurrent?: boolean;
}

export interface BusinessStepProjection {
  events: BusinessStepEventItem[];
  /** 按 anchor 消息 id 索引，供 groupMessages 在对应位置插入事件。 */
  eventsByAnchor: Map<string, BusinessStepEventItem[]>;
  /** 完整解析的 TodoWrite 消息 id；非 debug 视图隐藏原始工具块，由业务步骤事件承载。 */
  hiddenMessageIds: Set<string>;
}

/** 步骤差分事件沿用所属业务 Run，供渲染层建立稳定归属。 */
interface StepEventBase {
  type: "business_step";
  anchorMessageId: string;
  runId?: string;
  todo: TodoItem;
  stepIndex?: number;
  stepCount: number;
}

const TERMINAL_KIND_BY_STATUS: Partial<Record<TodoStatus, BusinessStepEventKind>> = {
  completed: "complete",
  failed: "fail",
  blocked: "block",
  waiting: "wait",
};

/** 终态事件（complete/fail/block/wait）：章节化时封闭对应步骤节。 */
export function isTerminalStepEvent(event: BusinessStepEventItem): boolean {
  return TERMINAL_KIND_BY_STATUS[event.todo?.status as TodoStatus] === event.kind;
}

/** 与 groupMessages 共用的章节边界判定，避免投影续接与实际封节语义分叉。 */
export function isBusinessStepSectionBoundary(message: MessageItem): boolean {
  if (message.type === "user") return message.status !== "queued";
  return message.type === "user-voice" || message.type.startsWith("system");
}

/**
 * 把 Business TodoWrite 快照序列差分成会话流内的业务步骤事件。
 *
 * 规则：
 * - 每个业务 Run 内首个完整 business 快照 → `plan` 事件（计划亮相，不回放快照内已有状态）；
 *   若首快照已有 in_progress 项，紧跟一条 `start` 事件——保证每个步骤都有自己的节标题，
 *   章节化（groupMessages sectioning）才能把后续过程内容归进该步骤；
 * - 后续快照 vs 上一快照逐步骤 diff：
 *   `→completed/failed/blocked/waiting` → 终态事件（携带该步骤最终 outcome/detail/display/evidence），
 *   `→in_progress` → `start` 事件（首次开始与等待后继续同形）；
 * - 收尾事件排在开新事件之前（同一快照先结旧步、再开新步）；
 * - 仅结构增删且无任何状态转移时补一条轻量 `update`；
 * - 章节边界消息默认开启新计划；若下一份 TodoWrite 与当前计划共享明确 runId，则视为同一次业务 Run 继续，
 *   只刷新原计划，并为仍在进行的当前步骤补发 start 以重开过程章节。这样用户回复/系统事件后续
 *   不会复制计划或丢失后半段过程，真实新任务仍会重新亮相。
 */
export function projectBusinessStepEvents(
  messages: MessageItem[],
  loading: boolean,
): BusinessStepProjection {
  const events: BusinessStepEventItem[] = [];
  const eventsByAnchor = new Map<string, BusinessStepEventItem[]>();
  const hiddenMessageIds = new Set<string>();

  let baseline: Map<string, TodoItem> | null = null;
  let latestActiveKey: string | null = null;
  /** 当前业务 Run 唯一的计划事件；后续快照原地刷新其步骤状态，不重复插入整份计划。 */
  let currentPlanEvent: BusinessStepEventItem | null = null;
  let currentPlanRunId: string | null = null;
  /** 已进入时间线、会让 groupMessages 封闭当前步骤节的章节边界。 */
  let pendingSectionBoundary = false;
  /** 最后一个承载「当前进行中」语义的事件（plan 或 start），用于 isCurrent 标注。 */
  let lastProgressEvent: BusinessStepEventItem | null = null;

  const pushEvents = (anchorId: string, batch: BusinessStepEventItem[]) => {
    if (!batch.length) return;
    events.push(...batch);
    const bucket = eventsByAnchor.get(anchorId) ?? [];
    bucket.push(...batch);
    eventsByAnchor.set(anchorId, bucket);
  };

  for (const message of messages) {
    if (isBusinessStepSectionBoundary(message)) {
      pendingSectionBoundary = true;
      continue;
    }
    if (message.type !== "tool_use" || message.toolName !== TODO_WRITE_TOOL_NAME) continue;

    const todos = parseTodos(message.toolInput);
    // streaming 中的不完整入参：不隐藏、不发事件，等完整快照一次性处理。
    if (todos === undefined) continue;

    const hadBusinessPlan = baseline !== null;
    const resetRunId = currentPlanRunId;
    const continuesCurrentRun = currentPlanRunId !== null && message.runId === currentPlanRunId;
    const resumesCurrentRunAfterSectionBoundary = pendingSectionBoundary && continuesCurrentRun;
    if (!continuesCurrentRun
      && (pendingSectionBoundary || (currentPlanRunId !== null && message.runId !== undefined))) {
      baseline = null;
      latestActiveKey = null;
      currentPlanEvent = null;
      currentPlanRunId = null;
      lastProgressEvent = null;
    }
    pendingSectionBoundary = false;

    hiddenMessageIds.add(message.id);

    const businessTodos = todos === null ? [] : todos.filter(isBusinessTodo);

    if (!businessTodos.length) {
      // 从业务计划退回空列表或纯 task 时，发一条仅供章节化消费的 reset：
      // groupMessages 据此关闭开放节，主区投影会忽略它，不制造第二套步骤正文。
      if (hadBusinessPlan) {
        pushEvents(message.id, [{
          type: "business_step",
          id: `bs-${message.id}-reset`,
          anchorMessageId: message.id,
          ...(resetRunId ? { runId: resetRunId } : {}),
          kind: "reset",
          stepCount: 0,
        }]);
      }
      baseline = null;
      latestActiveKey = null;
      currentPlanEvent = null;
      currentPlanRunId = null;
      lastProgressEvent = null;
      continue;
    }

    const stepCount = businessTodos.length;
    const indexByKey = new Map(businessTodos.map((todo, index) => [todoItemKey(todo), index + 1]));
    const activeTodo = businessTodos.find((todo) => todo.status === "in_progress");
    latestActiveKey = activeTodo ? todoItemKey(activeTodo) : null;

    if (baseline === null) {
      const planEvent: BusinessStepEventItem = {
        type: "business_step",
        id: `bs-${message.id}-plan`,
        anchorMessageId: message.id,
        ...(message.runId ? { runId: message.runId } : {}),
        kind: "plan",
        todos: businessTodos,
        stepCount,
      };
      currentPlanEvent = planEvent;
      currentPlanRunId = message.runId ?? null;
      const batch: BusinessStepEventItem[] = [planEvent];
      if (activeTodo) {
        const activeKey = todoItemKey(activeTodo);
        const startEvent: BusinessStepEventItem = {
          type: "business_step",
          id: `bs-${message.id}-${activeKey}-start`,
          anchorMessageId: message.id,
          ...(message.runId ? { runId: message.runId } : {}),
          kind: "start",
          todo: activeTodo,
          stepIndex: indexByKey.get(activeKey),
          stepCount,
        };
        batch.push(startEvent);
        lastProgressEvent = startEvent;
      } else {
        lastProgressEvent = null;
      }
      pushEvents(message.id, batch);
      baseline = new Map(businessTodos.map((todo) => [todoItemKey(todo), todo]));
      continue;
    }

    if (currentPlanEvent) {
      currentPlanEvent.todos = businessTodos;
      currentPlanEvent.stepCount = stepCount;
    }

    const closings: BusinessStepEventItem[] = [];
    const openings: BusinessStepEventItem[] = [];
    let structureChanged = false;
    let hasStateEvent = false;

    for (const todo of businessTodos) {
      const key = todoItemKey(todo);
      const prev = baseline.get(key);
      if (!prev) structureChanged = true;
      // 新增步骤按 pending 起点做虚拟转移：新增即 completed 的补记步骤也能发出终态事件。
      const prevStatus = prev?.status ?? "pending";
      // 章节边界会在 groupMessages 中封闭开放节。同一 Run 继续且当前步骤状态
      // 仍为 in_progress 时也要补一条 start，重开后半段过程的稳定归属；真实状态
      // 转为 in_progress 仍走常规差分，不重复发 start。
      const resumesUnchangedActive = resumesCurrentRunAfterSectionBoundary
        && key === latestActiveKey
        && prevStatus === "in_progress"
        && todo.status === "in_progress";
      if (prevStatus === todo.status && !resumesUnchangedActive) continue;

      const base: StepEventBase = {
        type: "business_step",
        anchorMessageId: message.id,
        ...(message.runId ? { runId: message.runId } : {}),
        todo,
        stepIndex: indexByKey.get(key),
        stepCount,
      };
      const terminalKind = TERMINAL_KIND_BY_STATUS[todo.status];
      if (resumesUnchangedActive) {
        openings.push({ ...base, id: `bs-${message.id}-${key}-start`, kind: "start" });
      } else if (terminalKind) {
        closings.push({ ...base, id: `bs-${message.id}-${key}-${terminalKind}`, kind: terminalKind });
        hasStateEvent = true;
      } else if (todo.status === "in_progress") {
        openings.push({ ...base, id: `bs-${message.id}-${key}-start`, kind: "start" });
        hasStateEvent = true;
      }
      // →pending 的回退（重排）不产生事件。
    }

    for (const key of baseline.keys()) {
      if (!indexByKey.has(key)) structureChanged = true;
    }

    // 有状态转移时结构变化不再单独播报（start/终态事件已是足够的叙事）；
    // 仅纯增删/重排时补一条轻量提示，避免计划演变在流内完全无痕。
    const updates: BusinessStepEventItem[] =
      structureChanged && !hasStateEvent
        ? [{
            type: "business_step",
            id: `bs-${message.id}-update`,
            anchorMessageId: message.id,
            ...(message.runId ? { runId: message.runId } : {}),
            kind: "update",
            stepCount,
          }]
        : [];

    pushEvents(message.id, [...closings, ...openings, ...updates]);
    if (openings.length) {
      lastProgressEvent = openings[openings.length - 1];
    }
    baseline = new Map(businessTodos.map((todo) => [todoItemKey(todo), todo]));
  }

  if (
    loading
    && latestActiveKey
    && lastProgressEvent?.todo
    && todoItemKey(lastProgressEvent.todo) === latestActiveKey
  ) {
    lastProgressEvent.isCurrent = true;
  }

  return { events, eventsByAnchor, hiddenMessageIds };
}
