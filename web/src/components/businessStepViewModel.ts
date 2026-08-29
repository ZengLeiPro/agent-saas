import {
  todoItemKey,
  type BusinessStepEventItem,
  type BusinessStepSection,
  type RenderItem,
  type TodoItem,
} from "@agent/shared";

export type BusinessStepFollowMode = "follow" | "fixed";

export interface BusinessStepSelection {
  sessionId: string | null;
  runId: string | null;
  planId: string;
  todoKey: string;
}

export interface BusinessStepDetailView {
  planId: string;
  todoKey: string;
  todo: TodoItem;
  stepIndex: number;
  stepCount: number;
  sections: BusinessStepSection[];
  terminal?: BusinessStepEventItem;
}

export interface BusinessStepPlanView {
  event: BusinessStepEventItem;
  details: BusinessStepDetailView[];
  currentTodoKey: string | null;
}

export interface BusinessStepCatalog {
  plans: BusinessStepPlanView[];
  planById: Map<string, BusinessStepPlanView>;
}

function isTerminalTodo(todo: TodoItem): boolean {
  return todo.status === "completed"
    || todo.status === "failed"
    || todo.status === "blocked"
    || todo.status === "waiting";
}

function mergeTerminalTodo(terminal: TodoItem, latest: TodoItem): TodoItem {
  const outcome = terminal.outcome && latest.outcome
    ? { ...terminal.outcome, ...latest.outcome }
    : latest.outcome ?? terminal.outcome;
  return {
    ...terminal,
    ...latest,
    ...(outcome ? { outcome } : {}),
  };
}

export function businessStepSelectionKey(selection: BusinessStepSelection): string {
  return [selection.sessionId ?? "", selection.runId ?? "", selection.planId, selection.todoKey]
    .map((part) => encodeURIComponent(part))
    .join("|");
}

export function detailSelection(
  sessionId: string | null | undefined,
  runId: string | null | undefined,
  planId: string,
  todoKey: string,
): BusinessStepSelection {
  return { sessionId: sessionId ?? null, runId: runId ?? null, planId, todoKey };
}

export function findBusinessStepDetail(
  catalog: BusinessStepCatalog,
  selection: BusinessStepSelection | null,
): BusinessStepDetailView | null {
  if (!selection) return null;
  const plan = catalog.planById.get(selection.planId);
  return plan?.details.find((detail) => detail.todoKey === selection.todoKey) ?? null;
}

/**
 * 从完整消息投影建立业务步骤目录。目录只保存稳定数据标识与原始 RenderItem 数据，
 * 不保存 ReactNode 或 DOM，因此选中步骤移出 MessageList 虚拟化窗口后仍可继续更新。
 * 历史步骤的终态结果会补入最新计划项，避免后续精简快照省略 detail/display 时丢失详情。
 */
export function buildBusinessStepCatalog(items: RenderItem[]): BusinessStepCatalog {
  const plans: BusinessStepPlanView[] = [];
  const planById = new Map<string, BusinessStepPlanView>();
  let currentPlan: BusinessStepPlanView | null = null;

  for (const item of items) {
    if (item.type === "business_step" && item.kind === "plan") {
      const todos = item.todos ?? [];
      const currentTodo = todos.find((todo) => todo.status === "in_progress");
      currentPlan = {
        event: item,
        details: todos.map((todo, index) => ({
          planId: item.id,
          todoKey: todoItemKey(todo),
          todo,
          stepIndex: index + 1,
          stepCount: todos.length,
          sections: [],
        })),
        currentTodoKey: currentTodo ? todoItemKey(currentTodo) : null,
      };
      plans.push(currentPlan);
      planById.set(item.id, currentPlan);
      continue;
    }

    if (!currentPlan) continue;

    if (item.type === "business_step_section") {
      const todo = item.terminal?.todo ?? item.start.todo;
      if (!todo) continue;
      const detail = currentPlan.details.find((candidate) => candidate.todoKey === todoItemKey(todo));
      if (!detail) continue;
      detail.sections.push(item);
      // 同一步骤可能 waiting 后恢复；新的开放节开始即结束上一终态作为“当前结果”的资格。
      detail.terminal = item.terminal;
      continue;
    }

    if (item.type === "business_step" && item.todo) {
      const detail = currentPlan.details.find((candidate) => candidate.todoKey === todoItemKey(item.todo!));
      if (!detail) continue;
      if (item.kind === "complete" || item.kind === "fail" || item.kind === "block" || item.kind === "wait") {
        detail.terminal = item;
      } else if (item.kind === "start") {
        detail.terminal = undefined;
      }
    }
  }

  for (const plan of plans) {
    for (const detail of plan.details) {
      if (!detail.terminal?.todo || !isTerminalTodo(detail.todo)) continue;
      if (detail.terminal.todo.status !== detail.todo.status) continue;
      detail.todo = mergeTerminalTodo(detail.terminal.todo, detail.todo);
    }
  }

  return { plans, planById };
}
