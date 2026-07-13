import type { ModelAggregate } from "@/components/UsageDashboard/types";
import type { DonutSlice } from "./charts";

const MODEL_COLORS = ["#6366f1", "#06b6d4", "#10b981", "#f59e0b"];

export interface BuildModelSlicesOptions {
  maxVisible?: number;
  /** 占比口径（默认 totalTokens；客户视角建议传 totalTurns） */
  getValue?: (model: ModelAggregate) => number;
  /** 展示名（默认原始模型 ID；客户视角传显示名映射） */
  getLabel?: (model: ModelAggregate) => string;
}

export function buildModelSlices(models: ModelAggregate[], options: BuildModelSlicesOptions = {}): DonutSlice[] {
  const { maxVisible = 4, getValue = model => model.totalTokens, getLabel = model => model.model } = options;
  const withValue = models
    .map(model => ({ model, value: getValue(model) }))
    .filter(item => Number.isFinite(item.value) && item.value > 0)
    .sort((a, b) => b.value - a.value);
  const visible = withValue.slice(0, maxVisible);
  const slices = visible.map((item, index) => ({
    label: getLabel(item.model),
    value: item.value,
    color: MODEL_COLORS[index % MODEL_COLORS.length],
  }));
  const remaining = withValue.slice(maxVisible);
  if (remaining.length > 0) {
    slices.push({
      label: `其余 ${remaining.length} 个模型`,
      value: remaining.reduce((sum, item) => sum + item.value, 0),
      color: "#94a3b8",
    });
  }
  return slices;
}

export function countActiveEnabledUsers(enabledUsernames: string[], usageUsernames: string[]): number {
  const active = new Set(usageUsernames);
  return enabledUsernames.filter(username => active.has(username)).length;
}
