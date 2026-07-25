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

/**
 * 北京时间的今天（YYYY-MM-DD）。
 *
 * 全站日切口径统一为北京时间：后端多处用 `AT TIME ZONE 'Asia/Shanghai'`，
 * 前端若用本地时区，跨时区访问时「今日」会和后端错开一天。
 */
export function todayBeijingDate(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 区块的真实统计窗口。capped=true 表示用户选的区间长于该后端上限，数据已被截断 */
export interface StatsWindow {
  days: number;
  capped: boolean;
}

/**
 * RangeSelector 的选择 → 后端天数窗口。
 *
 * cap 是各后端能提供的最大天数（efficiency 30 / billing audit 90）。同一个页面上不同区块
 * 的 cap 不同，导致顶部选「全部」时各区块实际窗口并不一致——必须通过 capped 标记暴露出来，
 * 否则客户会把「近 30 天」的数字当成「全部历史」对外汇报。
 */
export function rangeToStatsWindow(
  range: "today" | "7d" | "30d" | "all" | "mtd" | "custom",
  custom: { from: string; to: string } | null,
  cap: number,
  todayDate: string,
): StatsWindow {
  const clamp = (requested: number): StatsWindow => ({
    days: Math.min(cap, Math.max(1, requested)),
    capped: requested > cap,
  });
  switch (range) {
    case "today":
      return clamp(1);
    case "7d":
      return clamp(7);
    case "30d":
      return clamp(30);
    case "all":
      // “全部”意味着用户要的是不设限的历史，任何有限 cap 都构成截断
      return { days: cap, capped: true };
    case "mtd":
      return clamp(Number(todayDate.slice(8, 10)));
    case "custom": {
      if (!custom) return clamp(7);
      const fromMs = Date.parse(custom.from);
      const toMs = Date.parse(custom.to);
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return clamp(7);
      return clamp(Math.ceil((toMs - fromMs) / 86_400_000));
    }
  }
}

/** 区块统计窗口的说明文案：被截断时显式说明，避免与顶部时间选择器的标签冲突理解 */
export function windowCaption(window: StatsWindow): string {
  return window.capped ? `近 ${window.days} 天（本区块数据上限）` : `近 ${window.days} 天`;
}
