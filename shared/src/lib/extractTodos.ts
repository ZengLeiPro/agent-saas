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

    bucket.push({
      id: message.toolId || message.id,
      toolName: message.toolName,
      label: message.presentation?.title || message.toolName,
      ...(message.executionStatus ? { status: message.executionStatus } : {}),
    });
    activities[activeTodoKey] = bucket;
  }

  return activities;
}
