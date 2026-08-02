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

export interface TodoItem {
  /** 稳定业务步骤 ID；旧 TodoWrite 快照可以不带。 */
  id?: string;
  /** task 保持原有轻量样式；business 启用富业务步骤展示。 */
  kind?: "task" | "business";
  content: string;
  status: TodoStatus;
  activeForm?: string;
  detail?: DetailLine[];
  /** TodoWrite 只接受无交互的 callout / records；审批继续走真实 interaction 通道。 */
  display?: PresentationBlock[];
  /** 引用真实事实、对象或回执的稳定标识。 */
  evidenceRefs?: string[];
}

const TODO_WRITE_TOOL_NAME = "TodoWrite";
const TODO_DETAIL_LIMIT = 60;
const TODO_EVIDENCE_LIMIT = 20;

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

function normalizeTodoDisplay(raw: unknown): PresentationBlock[] | undefined {
  const blocks = normalizeDisplay(raw);
  if (!blocks) return undefined;

  const safeBlocks = blocks.flatMap((block): PresentationBlock[] => {
    // Todo 只负责展示业务步骤。需要回写的 gate 必须绑定真实 ask_user / permission 流程，
    // 不能让一段 TodoWrite 入参凭空制造可点击审批。
    if (block.kind === "gate") return [];
    const { actions: _actions, ...safeBlock } = block;
    return [safeBlock];
  });

  return safeBlocks.length ? safeBlocks : undefined;
}

function normalizeTodoItem(raw: unknown): TodoItem | null {
  if (!raw || typeof raw !== "object") return null;
  const todo = raw as Record<string, unknown>;
  const content = text(todo.content, 500);
  if (!content || !isTodoStatus(todo.status)) return null;

  const id = text(todo.id, 100);
  const activeForm = text(todo.activeForm, 500);
  const kind = todo.kind === "business" || todo.kind === "task" ? todo.kind : undefined;

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
    ...(detail.length ? { detail } : {}),
    ...(display ? { display } : {}),
    ...(evidenceRefs.length ? { evidenceRefs } : {}),
  };
}

/**
 * Returns undefined when the input is not a complete TodoWrite payload yet.
 * Returns null when a complete payload explicitly means "no todos".
 */
function parseTodos(toolInput: string): TodoItem[] | null | undefined {
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
// - 计划总览职责交给常驻导航（TodoPanel），流内只保留叙事事件。
// - 投影是纯函数、无累积状态：同一输入永远产出同一事件序列（React 重渲染幂等）。

export type BusinessStepEventKind =
  | "plan"
  | "start"
  | "complete"
  | "fail"
  | "block"
  | "wait"
  | "update";

export interface BusinessStepEventItem {
  type: "business_step";
  /** 由 anchor 消息 id + 步骤 key + 事件种类构成，天然稳定、幂等。 */
  id: string;
  /** 产生本事件的 TodoWrite 消息 id，决定事件在会话流中的位置。 */
  anchorMessageId: string;
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
  /** 完整解析的 TodoWrite 消息 id；非 debug 视图从主流隐藏（TodoPanel 承载总览）。 */
  hiddenMessageIds: Set<string>;
}

interface StepEventBase {
  type: "business_step";
  anchorMessageId: string;
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

/**
 * 把 Business TodoWrite 快照序列差分成会话流内的业务步骤事件。
 *
 * 规则：
 * - 每个用户 Turn 内首个完整 business 快照 → `plan` 事件（计划亮相，不回放快照内已有状态）；
 * - 后续快照 vs 上一快照逐步骤 diff：
 *   `→completed/failed/blocked/waiting` → 终态事件（携带该步骤最终 detail/display/evidence），
 *   `→in_progress` → `start` 事件（首次开始与等待后继续同形）；
 * - 收尾事件排在开新事件之前（同一快照先结旧步、再开新步）；
 * - 仅结构增删且无任何状态转移时补一条轻量 `update`；
 * - Turn 边界（user 消息）重置 baseline：跨 Turn 首快照重新亮相为 plan，不重复回放已完成步骤。
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
    if (message.type === "user") {
      baseline = null;
      latestActiveKey = null;
      lastProgressEvent = null;
      continue;
    }
    if (message.type !== "tool_use" || message.toolName !== TODO_WRITE_TOOL_NAME) continue;

    const todos = parseTodos(message.toolInput);
    // streaming 中的不完整入参：不隐藏、不发事件，等完整快照一次性处理。
    if (todos === undefined) continue;

    hiddenMessageIds.add(message.id);

    const businessTodos = todos === null ? [] : todos.filter(isBusinessTodo);

    if (!businessTodos.length) {
      // 整体替换语义下没有 business 项 = 业务步骤列表被清空（任务收尾或退回纯 task）。
      // 终态事件此前都已发出，这里静默清 baseline，不再追加噪音。
      baseline = null;
      latestActiveKey = null;
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
        kind: "plan",
        todos: businessTodos,
        stepCount,
      };
      pushEvents(message.id, [planEvent]);
      lastProgressEvent = planEvent;
      baseline = new Map(businessTodos.map((todo) => [todoItemKey(todo), todo]));
      continue;
    }

    const closings: BusinessStepEventItem[] = [];
    const openings: BusinessStepEventItem[] = [];
    let structureChanged = false;

    for (const todo of businessTodos) {
      const key = todoItemKey(todo);
      const prev = baseline.get(key);
      if (!prev) structureChanged = true;
      // 新增步骤按 pending 起点做虚拟转移：新增即 completed 的补记步骤也能发出终态事件。
      const prevStatus = prev?.status ?? "pending";
      if (prevStatus === todo.status) continue;

      const base: StepEventBase = {
        type: "business_step",
        anchorMessageId: message.id,
        todo,
        stepIndex: indexByKey.get(key),
        stepCount,
      };
      const terminalKind = TERMINAL_KIND_BY_STATUS[todo.status];
      if (terminalKind) {
        closings.push({ ...base, id: `bs-${message.id}-${key}-${terminalKind}`, kind: terminalKind });
      } else if (todo.status === "in_progress") {
        openings.push({ ...base, id: `bs-${message.id}-${key}-start`, kind: "start" });
      }
      // →pending 的回退（重排）不产生事件。
    }

    for (const key of baseline.keys()) {
      if (!indexByKey.has(key)) structureChanged = true;
    }

    // 有状态转移时结构变化不再单独播报（start/终态事件已是足够的叙事）；
    // 仅纯增删/重排时补一条轻量提示，避免计划演变在流内完全无痕。
    const updates: BusinessStepEventItem[] =
      structureChanged && !closings.length && !openings.length
        ? [{
            type: "business_step",
            id: `bs-${message.id}-update`,
            anchorMessageId: message.id,
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

  if (loading && latestActiveKey && lastProgressEvent) {
    const matchesActive = lastProgressEvent.kind === "plan"
      ? lastProgressEvent.todos?.some(
          (todo) => todo.status === "in_progress" && todoItemKey(todo) === latestActiveKey,
        )
      : lastProgressEvent.todo && todoItemKey(lastProgressEvent.todo) === latestActiveKey;
    if (matchesActive) lastProgressEvent.isCurrent = true;
  }

  return { events, eventsByAnchor, hiddenMessageIds };
}

export function extractLatestTodos(messages: MessageItem[]): TodoItem[] | null {
  let hasUserMessageAfterTodo = false;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];

    if (message.type === "user") {
      hasUserMessageAfterTodo = true;
      continue;
    }

    if (message.type !== "tool_use" || message.toolName !== TODO_WRITE_TOOL_NAME) {
      continue;
    }

    const todos = parseTodos(message.toolInput);
    if (todos === undefined) continue;
    if (todos === null) return null;

    const allCompleted = todos.every((todo) => todo.status === "completed");
    if (allCompleted && hasUserMessageAfterTodo) return null;

    return todos;
  }

  return null;
}
