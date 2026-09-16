import type { BusinessStepCatalog, BusinessStepDetailView } from "@agent/shared";
import {
  buildBusinessStepCatalog,
  businessStepTimingByPlanId,
  businessStepTimingByTodoKey,
  resolveBusinessStepDurationMs,
  type BusinessStepPlanView,
  type BusinessStepTodoTiming,
} from "@agent/shared";

export type {
  BusinessStepCatalog,
  BusinessStepDetailView,
  BusinessStepPlanView,
  BusinessStepTodoTiming,
};
export {
  buildBusinessStepCatalog,
  businessStepTimingByPlanId,
  businessStepTimingByTodoKey,
  resolveBusinessStepDurationMs,
};

export type BusinessStepFollowMode = "follow" | "fixed";

export interface BusinessStepSelection {
  sessionId: string | null;
  runId: string | null;
  planId: string;
  generationId?: string;
  todoKey: string;
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
  generationId?: string,
): BusinessStepSelection {
  return { sessionId: sessionId ?? null, runId: runId ?? null, planId, todoKey, generationId };
}

export function findBusinessStepDetail(
  catalog: BusinessStepCatalog,
  selection: BusinessStepSelection | null,
): BusinessStepDetailView | null {
  if (!selection) return null;
  const plan = catalog.planById.get(selection.planId);
  return plan?.details.find((detail) => detail.todoKey === selection.todoKey) ?? null;
}
