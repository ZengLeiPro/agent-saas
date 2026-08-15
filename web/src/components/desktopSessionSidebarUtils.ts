import type { ChatSessionIndexItem } from "@/types/sidebar";

export function formatBillingCredits(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Math.abs(value) >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  if (Math.abs(value) >= 100) return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function formatDetailedBillingCredits(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export function billingModeLabel(mode: string): string {
  switch (mode) {
    case "prepaid":
      return "预付费";
    case "postpaid":
      return "后付费";
    case "trial":
      return "试用";
    default:
      return "积分";
  }
}

export function compareSessionActivity(a: ChatSessionIndexItem, b: ChatSessionIndexItem): number {
  if (Boolean(a.isRunning) !== Boolean(b.isRunning)) return a.isRunning ? -1 : 1;
  return b.updatedAt - a.updatedAt;
}
