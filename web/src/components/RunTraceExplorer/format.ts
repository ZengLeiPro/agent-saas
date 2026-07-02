/** Run 追踪 / 效率视图共用格式化工具 */

/** 人民币成本：默认保留 4 位（成本只展示累计口径） */
export function formatYuan(n: number | null | undefined, digits = 4): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `¥${n.toFixed(digits)}`;
}

/**
 * 毫秒转人话：<1s 显示 ms；<60s 显示 s；<60min 显示 min；再往上显示 h。
 * null / 非法值显示 "—"。
 */
export function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}min ${Math.round(s % 60)}s`;
  const h = m / 60;
  return `${Math.floor(h)}h ${Math.round(m % 60)}min`;
}

/** ISO 时间 → zh-CN "MM-dd HH:mm:ss"；空值显示 "—" */
export function formatTime(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

/** 整数带千分位；null 显示 "—" */
export function formatCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString();
}

/** 比率 → 百分比；null 显示 "—" */
export function formatRate(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(1)}%`;
}

/** id 截断显示（默认前 8 位） */
export function shortId(id: string | null | undefined, len = 8): string {
  if (!id) return "—";
  return id.length > len ? `${id.slice(0, len)}…` : id;
}

/**
 * run 起止时间戳 → 耗时 ms（终态时间 - startedAt）；算不出返回 null。
 */
export function runDurationMs(run: {
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
}): number | null {
  if (!run.startedAt) return null;
  const end = run.completedAt ?? run.failedAt ?? run.cancelledAt;
  if (!end) return null;
  const startMs = new Date(run.startedAt).getTime();
  const endMs = new Date(end).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) return null;
  return endMs - startMs;
}
