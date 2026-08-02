import type { BusinessTodoGroup, MessageItem } from "../types/message";
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

export interface TodoToolActivity {
  id: string;
  toolName: string;
  label: string;
  status?: "pending" | "running" | "completed" | "failed" | "cancelled";
}

const TODO_WRITE_TOOL_NAME = "TodoWrite";
const TODO_DETAIL_LIMIT = 60;
const TODO_EVIDENCE_LIMIT = 20;
const TODO_ACTIVITY_LIMIT = 50;

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

export function isRichTodo(todo: TodoItem): boolean {
  return todo.kind === "business"
    || !!todo.detail?.length
    || !!todo.display?.length
    || !!todo.evidenceRefs?.length;
}

export function isBusinessTodo(todo: TodoItem): boolean {
  return todo.kind === "business";
}

function toToolActivity(message: Extract<MessageItem, { type: "tool_use" }>): TodoToolActivity {
  return {
    id: message.toolId || message.id,
    toolName: message.toolName,
    label: message.presentation?.title || message.toolName,
    ...(message.executionStatus ? { status: message.executionStatus } : {}),
  };
}

export interface BusinessTodoProjection {
  groups: BusinessTodoGroup[];
  /** 已被业务步骤卡吸收的 TodoWrite 与普通工具消息，避免在主流重复出现。 */
  hiddenSourceMessageIds: Set<string>;
}

interface BusinessTodoTurnState {
  turnId: string;
  anchorMessageId?: string;
  latestTodos?: TodoItem[];
  activitiesByTodo: Record<string, TodoToolActivity[]>;
  toolMessagesByTodo: Record<string, Array<Extract<MessageItem, { type: "tool_use" }>>>;
  activeTodoKey: string | null;
}

/**
 * 把每个用户 Turn 内的 Business TodoWrite 快照折叠成一个稳定的主会话渲染单元。
 * 首次 Business TodoWrite 决定卡片位置，后续完整快照只更新内容，不追加新卡片。
 */
export function projectBusinessTodoGroups(messages: MessageItem[], loading: boolean): BusinessTodoProjection {
  const groups: BusinessTodoGroup[] = [];
  const hiddenSourceMessageIds = new Set<string>();
  let state: BusinessTodoTurnState | null = null;
  let anonymousTurn = 0;

  const ensureTurn = (): BusinessTodoTurnState => {
    if (!state) {
      anonymousTurn += 1;
      state = {
        turnId: `anonymous-${anonymousTurn}`,
        activitiesByTodo: {},
        toolMessagesByTodo: {},
        activeTodoKey: null,
      };
    }
    return state;
  };

  const flushTurn = () => {
    if (!state?.anchorMessageId || !state.latestTodos?.length) return;
    groups.push({
      type: "business_todo",
      id: `business-todo-${state.anchorMessageId}`,
      turnId: state.turnId,
      anchorMessageId: state.anchorMessageId,
      todos: state.latestTodos,
      activitiesByTodo: state.activitiesByTodo,
      toolMessagesByTodo: state.toolMessagesByTodo,
      isActive: false,
    });
  };

  for (const message of messages) {
    if (message.type === "user") {
      flushTurn();
      state = {
        turnId: message.id,
        activitiesByTodo: {},
        toolMessagesByTodo: {},
        activeTodoKey: null,
      };
      continue;
    }
    if (message.type !== "tool_use") continue;

    const turn = ensureTurn();
    if (message.toolName === TODO_WRITE_TOOL_NAME) {
      const todos = parseTodos(message.toolInput);
      if (todos === undefined) continue;
      if (turn.anchorMessageId) hiddenSourceMessageIds.add(message.id);
      if (todos === null) {
        turn.activeTodoKey = null;
        continue;
      }

      const businessTodos = todos.filter(isBusinessTodo);
      if (businessTodos.length > 0) {
        turn.anchorMessageId ??= message.id;
        turn.latestTodos = businessTodos;
        hiddenSourceMessageIds.add(message.id);
      }
      const activeTodo = businessTodos.find((todo) => todo.status === "in_progress");
      turn.activeTodoKey = activeTodo ? todoItemKey(activeTodo) : null;
      continue;
    }

    if (!turn.activeTodoKey) continue;
    hiddenSourceMessageIds.add(message.id);
    const bucket = turn.activitiesByTodo[turn.activeTodoKey] ?? [];
    if (bucket.length >= TODO_ACTIVITY_LIMIT) continue;
    bucket.push(toToolActivity(message));
    turn.activitiesByTodo[turn.activeTodoKey] = bucket;
    const toolMessages = turn.toolMessagesByTodo[turn.activeTodoKey] ?? [];
    toolMessages.push(message);
    turn.toolMessagesByTodo[turn.activeTodoKey] = toolMessages;
  }

  const activeTurnId = state?.turnId;
  flushTurn();
  if (loading && activeTurnId) {
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const activeGroup = groups[index];
      if (activeGroup.turnId !== activeTurnId) continue;
      if (activeGroup.todos.some((todo) => todo.status === "in_progress")) {
        activeGroup.isActive = true;
      }
      break;
    }
  }

  return { groups, hiddenSourceMessageIds };
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

/**
 * 把两次 TodoWrite 快照之间的普通工具调用归入当时的 in_progress 步骤。
 * 这里只生成折叠后的业务活动索引，不复制原始入参和结果。
 */
export function extractTodoToolActivities(messages: MessageItem[]): Record<string, TodoToolActivity[]> {
  const activities: Record<string, TodoToolActivity[]> = {};
  let activeTodoKey: string | null = null;

  for (const message of messages) {
    if (message.type !== "tool_use") continue;

    if (message.toolName === TODO_WRITE_TOOL_NAME) {
      const todos = parseTodos(message.toolInput);
      if (todos === undefined) continue;
      if (todos === null) {
        for (const key of Object.keys(activities)) delete activities[key];
        activeTodoKey = null;
        continue;
      }
      const activeTodo = todos.find((todo) => todo.status === "in_progress");
      activeTodoKey = activeTodo ? todoItemKey(activeTodo) : null;
      continue;
    }

    if (!activeTodoKey) continue;
    const bucket = activities[activeTodoKey] ?? [];
    if (bucket.length >= TODO_ACTIVITY_LIMIT) continue;

    bucket.push(toToolActivity(message));
    activities[activeTodoKey] = bucket;
  }

  return activities;
}
