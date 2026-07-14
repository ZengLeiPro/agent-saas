/**
 * 共用：日趋势堆叠柱图（input/output/cacheRead/cacheCreation 四段）
 *
 * 实现要点（避免 SVG viewBox 拉伸把文字变形）：
 *   - 用 ResizeObserver 监听容器宽度
 *   - SVG 用真实像素尺寸，不用 viewBox 拉伸 → 字体按浏览器原生像素渲染，不模糊
 *   - 字号 11px，tabular-nums 数字等宽
 */

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { formatTokens } from "./format";

export interface TrendBarDatum {
  date: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
}

const DEFAULT_HEIGHT = 220;
const MIN_WIDTH = 320;
const PAD_L = 56;
const PAD_R = 16;
const PAD_T = 12;
const PAD_B = 30;
const BAR_GAP = 2;

export function TrendChart({ data, height = DEFAULT_HEIGHT }: { data: TrendBarDatum[]; height?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [W, setW] = useState<number>(800);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.max(MIN_WIDTH, Math.floor(entries[0].contentRect.width));
      setW(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (data.length === 0) {
    return (
      <div ref={containerRef} className="flex h-[220px] w-full items-center justify-center text-sm text-muted-foreground">
        无数据
      </div>
    );
  }

  const totals = data.map((d) => d.total);
  const maxTotal = Math.max(1, ...totals);

  const H = height;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const barW = Math.max(2, innerW / data.length - BAR_GAP);

  const yTicks = Array.from({ length: 5 }, (_, i) => {
    const v = (maxTotal / 4) * i;
    return { v, y: PAD_T + innerH - (v / maxTotal) * innerH };
  });

  // X 轴标签密度：宽度大就多显示几个
  const labelStep = Math.max(1, Math.ceil(data.length / Math.max(3, Math.floor(innerW / 80))));
  const labelIdxSet = new Set<number>([0, data.length - 1]);
  for (let i = labelStep; i < data.length - 1; i += labelStep) labelIdxSet.add(i);

  return (
    <div ref={containerRef} className="relative w-full overflow-hidden">
      <svg width={W} height={H} className="block">
        {/* 网格线 */}
        {yTicks.map((t, i) => (
          <line
            key={`g${i}`}
            x1={PAD_L}
            x2={W - PAD_R}
            y1={t.y}
            y2={t.y}
            stroke="currentColor"
            className="text-border"
            strokeDasharray="3,3"
          />
        ))}
        {/* Y 轴刻度文字 */}
        {yTicks.map((t, i) => (
          <text
            key={`yl${i}`}
            x={PAD_L - 8}
            y={t.y + 4}
            textAnchor="end"
            className="fill-muted-foreground tabular-nums"
            style={{ fontSize: 11 }}
          >
            {formatTokens(t.v)}
          </text>
        ))}
        {/* 柱子 */}
        {data.map((d, i) => {
          const total = d.total;
          const rawStackTotal = d.input + d.output + d.cacheRead + d.cacheCreation;
          const stackScale = rawStackTotal > 0 ? total / rawStackTotal : 0;
          const x = PAD_L + i * (barW + BAR_GAP);
          let y = PAD_T + innerH - (total / maxTotal) * innerH;
          const segs: { val: number; cls: string }[] = [
            { val: d.cacheRead, cls: "fill-blue-400 dark:fill-blue-500" },
            { val: d.cacheCreation, cls: "fill-purple-400 dark:fill-purple-500" },
            { val: d.input, cls: "fill-emerald-500 dark:fill-emerald-400" },
            { val: d.output, cls: "fill-amber-500 dark:fill-amber-400" },
          ];
          const isHover = hover === i;
          return (
            <g key={d.date} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={x - 1} y={PAD_T} width={barW + 2} height={innerH} fill="transparent" />
              {segs.map((s, si) => {
                if (s.val === 0) return null;
                const sh = ((s.val * stackScale) / maxTotal) * innerH;
                const r = (
                  <rect
                    key={si}
                    x={x}
                    y={y}
                    width={barW}
                    height={sh}
                    className={cn(s.cls, isHover && "opacity-80")}
                  />
                );
                y += sh;
                return r;
              })}
            </g>
          );
        })}
        {/* X 轴标签 */}
        {Array.from(labelIdxSet).map((i) => {
          const x = PAD_L + i * (barW + BAR_GAP) + barW / 2;
          return (
            <text
              key={`xl${i}`}
              x={x}
              y={H - 10}
              textAnchor="middle"
              className="fill-muted-foreground tabular-nums"
              style={{ fontSize: 11 }}
            >
              {data[i].date.slice(5)}
            </text>
          );
        })}
      </svg>

      {/* Hover tooltip（HTML 渲染，文字更清晰） */}
      {hover != null && data[hover] && (
        <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
          <div className="mb-1 font-medium tabular-nums">{data[hover].date}</div>
          <div className="space-y-0.5">
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">总计</span>
              <span className="font-mono tabular-nums">
                {formatTokens(data[hover].total)}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-sm bg-emerald-500" />输入</span>
              <span className="font-mono tabular-nums">{formatTokens(data[hover].input)}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-sm bg-amber-500" />输出</span>
              <span className="font-mono tabular-nums">{formatTokens(data[hover].output)}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-sm bg-blue-400" />缓存读</span>
              <span className="font-mono tabular-nums">{formatTokens(data[hover].cacheRead)}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-sm bg-purple-400" />缓存写</span>
              <span className="font-mono tabular-nums">{formatTokens(data[hover].cacheCreation)}</span>
            </div>
          </div>
        </div>
      )}

      {/* 图例 */}
      <div className="mt-1 flex flex-wrap items-center gap-3 px-2 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-emerald-500" />输入</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-amber-500" />输出</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-blue-400" />缓存读</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-purple-400" />缓存写</span>
      </div>
    </div>
  );
}
