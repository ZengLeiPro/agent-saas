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
