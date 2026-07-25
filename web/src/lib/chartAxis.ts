/**
 * 手绘 SVG 图表的坐标轴计算。
 *
 * 为什么不引图表库（2026-07-25 决定，推翻了本次改造规划里「引 Recharts」的初判）：
 *   1. `UsageDashboard/TrendChart.tsx` 已经把「七件套」做齐了——Y 轴带单位、网格、
 *      刻度密度自适应、HTML tooltip（比 SVG text 清晰）、图例、语义色 token，
 *      并且用 ResizeObserver + 真实像素尺寸而不是 viewBox 拉伸，字体不会变形。
 *      迁到 Recharts 的默认实现是**净倒退**。
 *   2. 真实缺口只在 `TenantAnalytics` 的 `MiniBarTrend`：无 Y 轴、无刻度、无单位，
 *      客户看到柱子高低不知道代表多少。补这些不需要一个 100KB 的依赖——TrendChart
 *      已经在同一个仓库里证明了。
 *   3. 当前 build 已有 chunk >500KB 警告，再加依赖是往反方向走。
 *
 * 所以这里把 TrendChart 里验证过的轴计算抽出来共用，而不是让第三个图表再抄一遍。
 */

export interface AxisTick {
  /** 刻度对应的数据值 */
  value: number;
  /** 刻度在 SVG 坐标系里的 y（像素） */
  y: number;
}

/**
 * 生成 Y 轴刻度。
 *
 * 刻度数固定而不是「取整到好看的数」——业务这几张图的量级跨度极大
 * （几十积分到几百万 token），凑整反而会让 max 被抬高一大截、柱子全压扁。
 */
export function buildYTicks({
  max,
  innerHeight,
  padTop,
  count = 4,
}: {
  max: number;
  innerHeight: number;
  padTop: number;
  /** 分段数，实际刻度条数为 count + 1（含 0） */
  count?: number;
}): AxisTick[] {
  const safeMax = max > 0 ? max : 1;
  return Array.from({ length: count + 1 }, (_, i) => {
    const value = (safeMax / count) * i;
    return { value, y: padTop + innerHeight - (value / safeMax) * innerHeight };
  });
}

/**
 * 挑选要显示的 X 轴标签下标。
 *
 * 首尾必显示（用户最先看的是「从哪天到哪天」），中间按可用宽度插空。
 * `minLabelWidth` 是一个标签的预估占宽，按 `MM-DD` 这种五字符标签取 80px。
 */
export function pickXLabelIndexes({
  count,
  innerWidth,
  minLabelWidth = 80,
}: {
  count: number;
  innerWidth: number;
  minLabelWidth?: number;
}): number[] {
  if (count <= 0) return [];
  if (count === 1) return [0];

  const capacity = Math.max(3, Math.floor(innerWidth / minLabelWidth));
  const step = Math.max(1, Math.ceil(count / capacity));
  const picked = new Set<number>([0, count - 1]);
  for (let i = step; i < count - 1; i += step) picked.add(i);
  return [...picked].sort((a, b) => a - b);
}

/**
 * 柱子宽度。留 `gap` 的间隙，并保证细到极限时至少有 1px 可见
 * （否则 90 天窗口下柱子会算成 0 宽度，图看起来是空的）。
 */
export function barWidth({
  innerWidth,
  count,
  gap = 2,
}: {
  innerWidth: number;
  count: number;
  gap?: number;
}): number {
  if (count <= 0) return 0;
  return Math.max(1, innerWidth / count - gap);
}
