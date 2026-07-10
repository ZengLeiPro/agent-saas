import type { ModelAggregate } from "@/components/UsageDashboard/types";
import type { DonutSlice } from "./charts";

const MODEL_COLORS = ["#6366f1", "#06b6d4", "#10b981", "#f59e0b"];

export function buildModelSlices(models: ModelAggregate[], maxVisible = 4): DonutSlice[] {
  const positive = models.filter(model => Number.isFinite(model.totalTokens) && model.totalTokens > 0);
  const visible = positive.slice(0, maxVisible);
  const slices = visible.map((model, index) => ({
    label: model.model,
    value: model.totalTokens,
    color: MODEL_COLORS[index % MODEL_COLORS.length],
  }));
  const remaining = positive.slice(maxVisible);
  if (remaining.length > 0) {
    slices.push({
      label: `其余 ${remaining.length} 个模型`,
      value: remaining.reduce((sum, model) => sum + model.totalTokens, 0),
      color: "#94a3b8",
    });
  }
  return slices;
}

export function countActiveEnabledUsers(enabledUsernames: string[], usageUsernames: string[]): number {
  const active = new Set(usageUsernames);
  return enabledUsernames.filter(username => active.has(username)).length;
}
