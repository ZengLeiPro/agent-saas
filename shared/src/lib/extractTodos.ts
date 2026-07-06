import type { MessageItem } from "../types/message";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

const TODO_WRITE_TOOL_NAME = "TodoWrite";

function isTodoStatus(status: unknown): status is TodoStatus {
  return status === "pending" || status === "in_progress" || status === "completed";
}

function normalizeTodoItem(raw: unknown): TodoItem | null {
  if (!raw || typeof raw !== "object") return null;
  const todo = raw as Record<string, unknown>;
  if (typeof todo.content !== "string" || !todo.content.trim()) return null;
  if (!isTodoStatus(todo.status)) return null;

  const activeForm = typeof todo.activeForm === "string" && todo.activeForm.trim()
    ? todo.activeForm.trim()
    : undefined;

  return {
    content: todo.content.trim(),
    status: todo.status,
    ...(activeForm ? { activeForm } : {}),
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
