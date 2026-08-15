/** 共用格式化工具：避免在 index.tsx 与 UserDetailView.tsx 之间重复 */

export function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return String(n);
}

export function formatUsd(n: number): string {
  if (n >= 1000) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

export function formatPercent(ratio: number | null): string {
  if (ratio == null) return "—";
  return `${(ratio * 100).toFixed(1)}%`;
}

export function formatDateRange(from: string, to: string): string {
  const f = from.replace("T", " ");
  const t = to.replace("T", " ");
  return f === t ? f : `${f} → ${t}`;
}

/** 全部范围有数据时展示后端解析出的真实 earliest date；无数据时不展示内部日期哨兵。 */
export function formatUsageRangeLabel(
  from: string,
  to: string,
  options: { range: string; hasData?: boolean },
): string {
  if (options.range === "all" && options.hasData === false) return "全部历史 / 无数据";
  return formatDateRange(from, to);
}
