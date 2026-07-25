import { useState } from "react";

import { buildYTicks, pickXLabelIndexes } from "@/lib/chartAxis";
import { cn } from "@/lib/utils";

export interface DonutSlice {
  label: string;
  value: number;
  color: string;
}

export function DonutChart({
  slices,
  centerValue,
  centerCaption = "Token",
  ariaLabel = "分布占比",
}: {
  slices: DonutSlice[];
  centerValue: string;
  /** 中心副标题（默认 Token；客户视角建议传「轮次」等业务口径） */
  centerCaption?: string;
  ariaLabel?: string;
}) {
  const size = 120;
  const thickness = 16;
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  const center = size / 2;
  const radius = size / 2 - thickness / 2 - 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} className="shrink-0" role="img" aria-label={ariaLabel}>
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={thickness}
          className="text-muted/70"
        />
        {total > 0 && slices.map((slice) => {
          const dash = (slice.value / total) * circumference;
          const circle = (
            <circle
              key={slice.label}
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke={slice.color}
              strokeWidth={thickness}
              strokeDasharray={`${dash} ${circumference - dash}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${center} ${center})`}
            />
          );
          offset += dash;
          return circle;
        })}
        <text x={center} y={center - 2} textAnchor="middle" className="fill-foreground text-[15px] font-semibold">
          {centerValue}
        </text>
        <text x={center} y={center + 14} textAnchor="middle" className="fill-muted-foreground text-2xs">
          {centerCaption}
        </text>
      </svg>
      <ul className="min-w-0 flex-1 space-y-1.5 text-xs">
        {slices.map((slice) => (
          <li key={slice.label} className="flex items-center gap-2">
            <span className="size-2.5 shrink-0 rounded-sm" style={{ backgroundColor: slice.color }} />
            <span className="min-w-0 flex-1 truncate text-muted-foreground" title={slice.label}>{slice.label}</span>
            <span className="tabular-nums text-foreground">
              {total > 0 ? `${((slice.value / total) * 100).toFixed(1)}%` : "0%"}
            </span>
          </li>
        ))}
        {slices.length === 0 && <li className="text-muted-foreground">暂无数据</li>}
      </ul>
    </div>
  );
}

export interface MiniTrendPoint {
  /** YYYY-MM-DD */
  date: string;
  value: number;
}

/**
 * 单序列日趋势柱状图（客户视角：对话轮次 / 积分消耗等单一业务口径）。
 *
 * 改造前的问题（交互审计判定这是客户侧最大的图表体验缺陷）：**没有 Y 轴、没有刻度、
 * 没有单位**——客户看到一排高低不同的柱子，完全不知道最高那根代表多少。信息只藏在
 * 原生 `title` 里，悬停有延迟，移动端根本出不来。
 *
 * 现在补齐：Y 轴刻度（带业务单位）+ 网格线 + 自适应密度的 X 轴标签 + HTML tooltip。
 * 轴计算复用 `lib/chartAxis`，与 `UsageDashboard/TrendChart` 同一套实现，不各写一遍。
 * 仍然不引图表库，理由见 `lib/chartAxis.ts` 顶部。
 */
export function MiniBarTrend({
  points,
  height = 160,
  barClassName = "bg-chart-1/80",
  formatValue = (value: number) => String(Math.round(value * 100) / 100),
  emptyText = "区间内暂无数据",
  unit,
}: {
  points: MiniTrendPoint[];
  height?: number;
  barClassName?: string;
  formatValue?: (value: number) => string;
  emptyText?: string;
  /** Y 轴单位（如「轮」「积分」）。不传则只显示数字 */
  unit?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);

  if (points.length === 0) {
    return (
      <div className="flex items-center justify-center text-xs text-muted-foreground" style={{ height }}>
        {emptyText}
      </div>
    );
  }

  const max = Math.max(...points.map(point => point.value), 1);
  // 刻度只取 2 段（0 / 半 / 满）——这是卡片内的小图，5 条刻度会糊成一片
  const ticks = buildYTicks({ max, innerHeight: height, padTop: 0, count: 2 });
  const labelIdxs = pickXLabelIndexes({ count: points.length, innerWidth: 320, minLabelWidth: 90 });

  return (
    <div className="relative">
      <div className="flex" style={{ height }}>
        {/* Y 轴刻度：客户得知道柱子高低代表多少 */}
        <div className="relative w-12 shrink-0">
          {ticks.map(tick => (
            <span
              key={tick.value}
              className="absolute right-1 -translate-y-1/2 text-2xs text-muted-foreground tabular-nums"
              style={{ top: tick.y }}
            >
              {formatValue(tick.value)}
            </span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          {/* 网格线 */}
          {ticks.map(tick => (
            <span
              key={tick.value}
              className="pointer-events-none absolute inset-x-0 border-t border-dashed border-border"
              style={{ top: tick.y }}
            />
          ))}
          <div className="flex h-full items-end gap-[2px]">
            {points.map((point, index) => {
              const ratio = Math.max(0, point.value) / max;
              return (
                <div
                  key={point.date}
                  className="group relative flex h-full flex-1 items-end rounded-sm hover:bg-muted/40"
                  onMouseEnter={() => setHover(index)}
                  onMouseLeave={() => setHover(null)}
                >
                  <div
                    className={cn("w-full rounded-sm transition-colors group-hover:opacity-80", barClassName)}
                    style={{ height: point.value > 0 ? `${Math.max(ratio * 100, 2)}%` : "1px" }}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* X 轴标签：不再只有首尾两个 */}
      <div className="ml-12 mt-1 flex text-2xs text-muted-foreground tabular-nums">
        {points.map((point, index) => (
          <span key={point.date} className="min-w-0 flex-1 text-center">
            {labelIdxs.includes(index) ? point.date.slice(5) : ""}
          </span>
        ))}
      </div>

      {/* HTML tooltip：比原生 title 即时，且移动端点按也能出 */}
      {hover != null && points[hover] && (
        <div className="pointer-events-none absolute right-0 top-0 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md">
          <div className="font-medium tabular-nums">{points[hover].date}</div>
          <div className="tabular-nums text-muted-foreground">
            {formatValue(points[hover].value)}{unit ? ` ${unit}` : ""}
          </div>
        </div>
      )}
    </div>
  );
}
