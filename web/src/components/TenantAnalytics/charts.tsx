import { useId } from "react";

import { cn } from "@/lib/utils";

interface SparklineProps {
  data: number[];
  className?: string;
}

export function Sparkline({ data, className }: SparklineProps) {
  const gradientId = useId();
  if (data.length === 0) return <div className={cn("h-10 w-full", className)} />;

  const width = 100;
  const height = 40;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const step = data.length > 1 ? width / (data.length - 1) : width;
  const points = data.map((value, index) => {
    const x = index * step;
    const y = height - ((value - min) / range) * (height - 4) - 2;
    return `${x},${y}`;
  });
  const path = `M${points.join(" L")}`;
  const areaPath = `${path} L${width},${height} L0,${height} Z`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={cn("h-10 w-full", className)} aria-hidden="true">
      <defs>
        <linearGradient id={`${gradientId}-stroke`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#ec4899" />
        </linearGradient>
        <linearGradient id={`${gradientId}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#6366f1" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradientId}-fill)`} />
      <path
        d={path}
        fill="none"
        stroke={`url(#${gradientId}-stroke)`}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

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
        <text x={center} y={center + 14} textAnchor="middle" className="fill-muted-foreground text-[10px]">
          {centerCaption}
        </text>
      </svg>
      <ul className="min-w-0 flex-1 space-y-1.5 text-xs">
        {slices.map((slice) => (
          <li key={slice.label} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: slice.color }} />
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
 * 轻量单序列日趋势柱状图（客户视角：对话轮次 / 积分消耗等单一业务口径）。
 * 原生 title 提示，不引入图表库。
 */
export function MiniBarTrend({
  points,
  height = 160,
  barClassName = "bg-indigo-400/80 dark:bg-indigo-500/70",
  formatValue = (value: number) => String(Math.round(value * 100) / 100),
  emptyText = "区间内暂无数据",
}: {
  points: MiniTrendPoint[];
  height?: number;
  barClassName?: string;
  formatValue?: (value: number) => string;
  emptyText?: string;
}) {
  if (points.length === 0) {
    return (
      <div className="flex items-center justify-center text-xs text-muted-foreground" style={{ height }}>
        {emptyText}
      </div>
    );
  }
  const max = Math.max(...points.map(point => point.value), 1);
  const first = points[0]?.date ?? "";
  const last = points[points.length - 1]?.date ?? "";
  return (
    <div>
      <div className="flex items-end gap-[2px]" style={{ height }}>
        {points.map(point => {
          const ratio = Math.max(0, point.value) / max;
          return (
            <div
              key={point.date}
              className="group relative flex h-full flex-1 items-end rounded-sm hover:bg-muted/50"
              title={`${point.date} · ${formatValue(point.value)}`}
            >
              <div
                className={cn("w-full rounded-sm transition-colors group-hover:opacity-80", barClassName)}
                style={{ height: point.value > 0 ? `${Math.max(ratio * 100, 2)}%` : "1px" }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground tabular-nums">
        <span>{first}</span>
        {points.length > 2 && <span>{last}</span>}
      </div>
    </div>
  );
}
