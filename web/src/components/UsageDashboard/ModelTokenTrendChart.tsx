import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { barWidth, buildYTicks, pickXLabelIndexes } from "@/lib/chartAxis";
import { cn } from "@/lib/utils";

import { formatTokens, formatUsd } from "./format";
import type { ModelTrendPoint, ModelTrendResp } from "./types";

const TOP_MODEL_COUNT = 6;
const MODEL_KEY_PREFIX = "model:";
const OTHER_KEY = "other";

function modelKey(model: string): string {
  return `${MODEL_KEY_PREFIX}${model}`;
}
const MODEL_COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
  "hsl(var(--primary))",
] as const;
const OTHER_COLOR = "#94a3b8";

const HEIGHT = 240;
const MIN_WIDTH = 320;
const PAD_L = 56;
const PAD_R = 16;
const PAD_T = 12;
const PAD_B = 30;
const BAR_GAP = 2;

export interface ModelTrendSeries {
  key: string;
  label: string;
  color: string;
  isOther: boolean;
}

export interface ModelTrendSegment {
  key: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  turns: number;
  costUsd?: number;
}

export interface PreparedModelTrendPoint {
  date: string;
  totalTokens: number;
  segments: ModelTrendSegment[];
}

export interface PreparedModelTrend {
  series: ModelTrendSeries[];
  points: PreparedModelTrendPoint[];
}

function safePositive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * 按整个区间选 Top 6；逐日把剩余模型合并到“其他”。
 * series 只生成一次并被所有日期复用，因此同一模型跨日期颜色稳定。
 */
export function prepareModelTrend(points: ModelTrendPoint[]): PreparedModelTrend {
  const intervalTotals = new Map<string, number>();
  for (const point of points) {
    for (const model of point.models) {
      intervalTotals.set(model.model, (intervalTotals.get(model.model) ?? 0) + safePositive(model.totalTokens));
    }
  }

  const topModels = [...intervalTotals.entries()]
    .filter(([, total]) => total > 0)
    .sort(([modelA, totalA], [modelB, totalB]) => totalB - totalA || modelA.localeCompare(modelB))
    .slice(0, TOP_MODEL_COUNT)
    .map(([model]) => model);
  const topSet = new Set(topModels);
  const hasOther = [...intervalTotals.entries()].some(([model, total]) => !topSet.has(model) && total > 0);

  const series: ModelTrendSeries[] = topModels.map((model, index) => ({
    key: modelKey(model),
    label: model,
    color: MODEL_COLORS[index],
    isOther: false,
  }));
  if (hasOther) {
    series.push({ key: OTHER_KEY, label: "其他", color: OTHER_COLOR, isOther: true });
  }

  const preparedPoints = points.map((point) => {
    const daily = new Map<string, Omit<ModelTrendSegment, "key">>();
    for (const model of point.models) {
      const key = topSet.has(model.model) ? modelKey(model.model) : OTHER_KEY;
      const current = daily.get(key) ?? {
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        turns: 0,
      };
      current.tokens += safePositive(model.totalTokens);
      current.inputTokens += safePositive(model.inputTokens);
      current.outputTokens += safePositive(model.outputTokens);
      current.cacheReadTokens += safePositive(model.cacheReadTokens);
      current.cacheCreationTokens += safePositive(model.cacheCreationTokens);
      current.turns += safePositive(model.totalTurns);
      if (Number.isFinite(model.totalCostUsd)) {
        current.costUsd = (current.costUsd ?? 0) + (model.totalCostUsd ?? 0);
      }
      daily.set(key, current);
    }
    const segments = series.map(({ key }) => ({
      key,
      ...(daily.get(key) ?? {
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        turns: 0,
      }),
    }));
    return {
      date: point.date,
      totalTokens: segments.reduce((sum, segment) => sum + segment.tokens, 0),
      segments,
    };
  });

  return { series, points: preparedPoints };
}

function segmentDescription(
  point: PreparedModelTrendPoint,
  segment: ModelTrendSegment,
  label: string,
  showCost: boolean,
): string {
  const share = point.totalTokens > 0 ? (segment.tokens / point.totalTokens) * 100 : 0;
  const cost = showCost && segment.costUsd !== undefined ? ` · 成本 ${formatUsd(segment.costUsd)}` : "";
  return `${point.date} · ${label} · Token ${formatTokens(segment.tokens)} · 占比 ${share.toFixed(1)}% · 输入 ${formatTokens(segment.inputTokens)} · 输出 ${formatTokens(segment.outputTokens)} · 缓存读 ${formatTokens(segment.cacheReadTokens)} · 缓存写 ${formatTokens(segment.cacheCreationTokens)} · 轮次 ${segment.turns.toLocaleString("zh-CN")}${cost}`;
}

function ModelTokenTrendChart({
  points,
  costRedacted,
  labelFor,
}: {
  points: ModelTrendPoint[];
  costRedacted: boolean;
  labelFor: (model: string) => string;
}) {
  const prepared = useMemo(() => prepareModelTrend(points), [points]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      setWidth(Math.max(MIN_WIDTH, Math.floor(entries[0].contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  if (prepared.series.length === 0 || prepared.points.every((point) => point.totalTokens === 0)) {
    return (
      <div ref={containerRef} className="flex h-60 items-center justify-center text-sm text-muted-foreground">
        所选区间内暂无模型 Token 用量
      </div>
    );
  }

  const visibleSeries = prepared.series.filter((series) => !hidden.has(series.key));
  const visibleKeys = new Set(visibleSeries.map((series) => series.key));
  const visibleTotals = prepared.points.map((point) => point.segments.reduce(
    (sum, segment) => sum + (visibleKeys.has(segment.key) ? segment.tokens : 0),
    0,
  ));
  const maxTotal = Math.max(1, ...visibleTotals);
  const innerWidth = width - PAD_L - PAD_R;
  const innerHeight = HEIGHT - PAD_T - PAD_B;
  const chartBarWidth = barWidth({ innerWidth, count: prepared.points.length, gap: BAR_GAP });
  const yTicks = buildYTicks({ max: maxTotal, innerHeight, padTop: PAD_T });
  const labelIndexes = pickXLabelIndexes({ count: prepared.points.length, innerWidth });
  const labels = new Map(prepared.series.map((series) => [
    series.key,
    series.isOther ? series.label : labelFor(series.label),
  ]));

  const toggleSeries = (key: string) => {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div
      ref={containerRef}
      className="relative w-full overflow-hidden"
      role="group"
      aria-label="按北京时间自然日统计的模型 Token 用量趋势"
    >
      <svg width={width} height={HEIGHT} className="block" aria-hidden="true" focusable="false">
        {yTicks.map((tick) => (
          <g key={tick.value}>
            <line
              x1={PAD_L}
              x2={width - PAD_R}
              y1={tick.y}
              y2={tick.y}
              stroke="currentColor"
              className="text-border"
              strokeDasharray="3,3"
            />
            <text
              x={PAD_L - 8}
              y={tick.y + 4}
              textAnchor="end"
              className="fill-muted-foreground tabular-nums"
              style={{ fontSize: 11 }}
            >
              {formatTokens(tick.value)}
            </text>
          </g>
        ))}

        {prepared.points.map((point, pointIndex) => {
          const x = PAD_L + pointIndex * (chartBarWidth + BAR_GAP);
          let y = PAD_T + innerHeight;
          return (
            <g key={point.date}>
              {point.segments.map((segment) => {
                const series = prepared.series.find((item) => item.key === segment.key);
                if (!series || hidden.has(segment.key) || segment.tokens <= 0) return null;
                const segmentHeight = (segment.tokens / maxTotal) * innerHeight;
                y -= segmentHeight;
                const description = segmentDescription(
                  point,
                  segment,
                  labels.get(segment.key) ?? series.label,
                  !costRedacted,
                );
                return (
                  <rect
                    key={segment.key}
                    x={x}
                    y={y}
                    width={chartBarWidth}
                    height={segmentHeight}
                    fill={series.color}
                  >
                    <title>{description}</title>
                  </rect>
                );
              })}
            </g>
          );
        })}

        {labelIndexes.map((index) => (
          <text
            key={prepared.points[index].date}
            x={PAD_L + index * (chartBarWidth + BAR_GAP) + chartBarWidth / 2}
            y={HEIGHT - 10}
            textAnchor="middle"
            className="fill-muted-foreground tabular-nums"
            style={{ fontSize: 11 }}
          >
            {prepared.points[index].date.slice(5)}
          </text>
        ))}
      </svg>

      <ul
        className="sr-only focus-within:not-sr-only focus-within:mt-2 focus-within:space-y-1 focus-within:rounded-md focus-within:border focus-within:bg-background focus-within:p-3 focus-within:text-xs"
        aria-label="模型 Token 用量明细"
      >
        {prepared.points.flatMap((point) => point.segments.map((segment) => {
          if (!visibleKeys.has(segment.key) || segment.tokens <= 0) return null;
          const series = prepared.series.find((item) => item.key === segment.key);
          if (!series) return null;
          const description = segmentDescription(
            point,
            segment,
            labels.get(segment.key) ?? series.label,
            !costRedacted,
          );
          return (
            <li
              key={`${point.date}:${segment.key}`}
              tabIndex={0}
              aria-label={description}
              className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {description}
            </li>
          );
        }))}
      </ul>

      {visibleSeries.length === 0 && (
        <div className="pointer-events-none absolute inset-x-0 top-24 text-center text-xs text-muted-foreground">
          已隐藏全部模型，点击图例恢复
        </div>
      )}

      <div className="mt-1 flex flex-wrap items-center gap-2 px-2" aria-label="模型图例">
        {prepared.series.map((series) => {
          const isVisible = !hidden.has(series.key);
          const label = labels.get(series.key) ?? series.label;
          return (
            <button
              key={series.key}
              type="button"
              aria-pressed={isVisible}
              aria-label={`${isVisible ? "隐藏" : "显示"} ${label}`}
              className={cn(
                "inline-flex items-center gap-1.5 rounded px-1.5 py-1 text-2xs text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                !isVisible && "line-through opacity-50",
              )}
              onClick={() => toggleSeries(series.key)}
            >
              <span className="size-2.5 rounded-sm" style={{ backgroundColor: series.color }} />
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ModelTokenTrendCard({
  response,
  loading,
  error,
  labelFor,
}: {
  response: ModelTrendResp | null;
  loading: boolean;
  error: string | null;
  labelFor: (model: string) => string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2">
          模型 Token 用量趋势
          {loading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="正在刷新模型趋势" />}
        </CardTitle>
        <div className="text-xs text-muted-foreground">柱高＝总 Token · 颜色＝模型 · 按北京时间自然日统计</div>
      </CardHeader>
      <CardContent>
        {error && (
          <div role="alert" className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error.includes("→ 404") ? "模型趋势数据源未启用" : `模型趋势加载失败：${error}`}
          </div>
        )}
        {!response && loading ? (
          <div className="flex h-60 items-center justify-center text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" /> 正在加载模型趋势…
          </div>
        ) : response ? (
          <ModelTokenTrendChart
            points={response.points}
            costRedacted={response.costRedacted === true}
            labelFor={labelFor}
          />
        ) : !error ? (
          <div className="flex h-60 items-center justify-center text-sm text-muted-foreground">所选区间内暂无模型 Token 用量</div>
        ) : null}
      </CardContent>
    </Card>
  );
}
