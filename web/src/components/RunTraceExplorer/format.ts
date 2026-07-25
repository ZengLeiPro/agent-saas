/** Run 追踪 / 效率视图共用格式化工具 */

/** 人民币成本：默认保留 4 位（成本只展示累计口径） */
export function formatYuan(n: number | null | undefined, digits = 4): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n > 0 && n < 0.01) return "不足 ¥0.01";
  return `¥${n.toFixed(digits)}`;
}

/**
 * 毫秒转人话：<1s 显示 ms；<60s 显示 s；<60min 显示 min；再往上显示 h。
 * null / 非法值显示 "—"。
 */
export function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} 秒`;
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)} 分 ${Math.round(s % 60)} 秒`;
  const h = m / 60;
  return `${Math.floor(h)} 小时 ${Math.round(m % 60)} 分`;
}

/**
 * 时间线的**相对偏移**（对标 waterfall 横轴的 `3s / 8s / 13s`）：以 run 起点为 0。
 *
 * 为什么不直接复用 `formatMs`：这个值出现在时间线每一行的同一列上，需要**等宽可纵向扫读**
 * 且尽量短（`+13.81s` 比 `+13.8 秒` 窄一档、比 `+1 分 3 秒` 窄两档）。绝对时刻不丢——
 * 调用点把 `formatTime` 放进 `title`（口径可查是本模块的既有约定）。
 *
 * 非法值 / 负偏移一律 "—"（空值统一 "—" 的既有优势）。
 */
export function formatOffset(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 60_000) return `+${(ms / 1000).toFixed(2)}s`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `+${minutes}m${String(totalSeconds % 60).padStart(2, "0")}s`;
  return `+${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** 两个 ISO 时间戳之差（ms）；任一非法 → null */
export function diffMs(timestamp?: string | null, origin?: string | null): number | null {
  if (!timestamp || !origin) return null;
  const a = new Date(timestamp).getTime();
  const b = new Date(origin).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return a - b;
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
