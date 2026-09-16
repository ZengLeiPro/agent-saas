/**
 * 业务步骤目录与墙钟耗时（纯函数，无 DOM / React 依赖）。
 *
 * 与 `web/src/components/businessStepViewModel.ts` 同源：两端主卡按 todoKey 取
 * 并行感知墙钟；目录只存稳定数据标识，选中步骤移出虚拟化窗口后仍可更新。
 */
import type { BusinessStepSection, RenderItem } from '../types/message';
import type { BusinessStepEventItem, TodoItem } from './extractTodos';
import { todoItemKey } from './extractTodos';
import {
  activityWallClockDurationMs,
  collectActivityTimingLeaves,
  earliestLiveStartedAtMs,
} from './wallClockDuration';

export interface BusinessStepDetailView {
  planId: string;
  todoKey: string;
  todo: TodoItem;
  stepIndex: number;
  stepCount: number;
  sections: BusinessStepSection[];
  terminal?: BusinessStepEventItem;
  /** 步骤过程叶子的墙钟耗时（并行并集）；缺数据时省略。 */
  durationMs?: number;
  /** 进行中叶子的最早 startedAt；有值表示主卡应 tick。 */
  liveStartedAtMs?: number;
  /** 计算 durationMs 时的墙钟；live 时用 now - measuredAt 外推。 */
  timingMeasuredAtMs?: number;
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

/** 主卡按 todoKey 取墙钟耗时；live 起点供进行中行本地 tick。 */
export type BusinessStepTodoTiming = {
  durationMs?: number;
  liveStartedAtMs?: number;
  timingMeasuredAtMs?: number;
};

function isTerminalTodo(todo: TodoItem): boolean {
  return (
    todo.status === 'completed' ||
    todo.status === 'failed' ||
    todo.status === 'blocked' ||
    todo.status === 'waiting'
  );
}

function mergeTerminalTodo(terminal: TodoItem, latest: TodoItem): TodoItem {
  const outcome =
    terminal.outcome && latest.outcome
      ? { ...terminal.outcome, ...latest.outcome }
      : (latest.outcome ?? terminal.outcome);
  return {
    ...terminal,
    ...latest,
    ...(outcome ? { outcome } : {}),
  };
}

/**
 * 从完整消息投影建立业务步骤目录。目录只保存稳定数据标识与原始 RenderItem 数据，
 * 不保存 ReactNode 或 DOM，因此选中步骤移出虚拟化窗口后仍可继续更新。
 * 历史步骤的终态结果会补入最新计划项，避免后续精简快照省略 detail/display 时丢失详情。
 */
export function buildBusinessStepCatalog(items: RenderItem[]): BusinessStepCatalog {
  const plans: BusinessStepPlanView[] = [];
  const planById = new Map<string, BusinessStepPlanView>();
  let currentPlan: BusinessStepPlanView | null = null;

  for (const item of items) {
    if (item.type === 'business_step' && item.kind === 'plan') {
      const todos = item.todos ?? [];
      const currentTodo = todos.find((todo) => todo.status === 'in_progress');
      // reset 后保留历史主卡与详情，但不再提供“当前步骤”跟随语义。
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
        currentTodoKey: !item.isClosed && currentTodo ? todoItemKey(currentTodo) : null,
      };
      plans.push(currentPlan);
      planById.set(item.id, currentPlan);
      continue;
    }

    if (!currentPlan) continue;

    if (item.type === 'business_step_section') {
      const todo = item.terminal?.todo ?? item.start.todo;
      if (!todo) continue;
      const detail = currentPlan.details.find(
        (candidate) => candidate.todoKey === todoItemKey(todo),
      );
      if (!detail) continue;
      detail.sections.push(item);
      // 同一步骤可能 waiting 后恢复；新的开放节开始即结束上一终态作为“当前结果”的资格。
      detail.terminal = item.terminal;
      continue;
    }

    if (item.type === 'business_step' && item.todo) {
      const detail = currentPlan.details.find(
        (candidate) => candidate.todoKey === todoItemKey(item.todo!),
      );
      if (!detail) continue;
      if (
        item.kind === 'complete' ||
        item.kind === 'fail' ||
        item.kind === 'block' ||
        item.kind === 'wait'
      ) {
        detail.terminal = item;
      } else if (item.kind === 'start') {
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

  for (const plan of plans) {
    for (const detail of plan.details) {
      const leaves = collectActivityTimingLeaves(detail.sections);
      const measuredAtMs = Date.now();
      const durationMs = activityWallClockDurationMs(leaves, { nowMs: measuredAtMs });
      if (durationMs !== undefined) detail.durationMs = durationMs;
      const liveStartedAtMs = earliestLiveStartedAtMs(leaves);
      if (liveStartedAtMs !== undefined) {
        detail.liveStartedAtMs = liveStartedAtMs;
        detail.timingMeasuredAtMs = measuredAtMs;
      }
    }
  }

  return { plans, planById };
}

/** 主卡按 todoKey 取墙钟耗时；live 字段供进行中行本地 tick。 */
export function businessStepTimingByTodoKey(
  plan: BusinessStepPlanView | null | undefined,
): Map<string, BusinessStepTodoTiming> {
  const map = new Map<string, BusinessStepTodoTiming>();
  if (!plan) return map;
  for (const detail of plan.details) {
    if (detail.durationMs === undefined && detail.liveStartedAtMs === undefined) continue;
    map.set(detail.todoKey, {
      ...(detail.durationMs !== undefined ? { durationMs: detail.durationMs } : {}),
      ...(detail.liveStartedAtMs !== undefined ? { liveStartedAtMs: detail.liveStartedAtMs } : {}),
      ...(detail.timingMeasuredAtMs !== undefined
        ? { timingMeasuredAtMs: detail.timingMeasuredAtMs }
        : {}),
    });
  }
  return map;
}

/** 目录 → 计划 id → todoKey 耗时；MessageList 一次建好供主卡消费。 */
export function businessStepTimingByPlanId(
  catalog: BusinessStepCatalog,
): Map<string, Map<string, BusinessStepTodoTiming>> {
  const maps = new Map<string, Map<string, BusinessStepTodoTiming>>();
  for (const plan of catalog.plans) {
    maps.set(plan.event.id, businessStepTimingByTodoKey(plan));
  }
  return maps;
}

/** 把目录快照时的耗时外推到 now（仅 live 行）。 */
export function resolveBusinessStepDurationMs(
  timing: BusinessStepTodoTiming | undefined,
  nowMs: number,
): number | undefined {
  if (!timing) return undefined;
  const base = timing.durationMs;
  if (
    timing.liveStartedAtMs !== undefined &&
    timing.timingMeasuredAtMs !== undefined &&
    base !== undefined
  ) {
    return Math.max(0, base + (nowMs - timing.timingMeasuredAtMs));
  }
  if (timing.liveStartedAtMs !== undefined) {
    return Math.max(0, nowMs - timing.liveStartedAtMs);
  }
  return base;
}
