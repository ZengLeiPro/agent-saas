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
 * 轻量单序列日趋势柱状图（客户视角：对话轮次 / 积分消耗等单一业务口径）。
 * 原生 title 提示，不引入图表库。
 */
export function MiniBarTrend({
  points,
  height = 160,
  barClassName = "bg-chart-1/80",
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
      <div className="mt-1 flex items-center justify-between text-2xs text-muted-foreground tabular-nums">
        <span>{first}</span>
        {points.length > 2 && <span>{last}</span>}
      </div>
    </div>
  );
}
