import { useState, useRef, useEffect } from "react";
import type { TokenUsage } from "@/lib/sessionsApi";
import type { ContextUsageData } from "@agent/shared";
import { formatTokenCount } from "@/lib/sessionsApi";

interface TokenUsageDisplayProps {
  tokenUsage: TokenUsage | null;
  /** SDK 0.2.112+ 实时推送的上下文占用细分，优先于 tokenUsage 展示 */
  contextUsage?: ContextUsageData | null;
  /** 租户模型策略：是否允许点击展开 Token 明细。 */
  allowDetails?: boolean;
}

function DetailRow({ label, value }: { label: string; value: number | string }) {
  const displayValue = typeof value === "number" ? value.toLocaleString() : value;

  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums">{displayValue}</span>
    </div>
  );
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function TokenUsageDisplay({ tokenUsage, contextUsage, allowDetails = false }: TokenUsageDisplayProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const cumulativeTokens = tokenUsage
    ? tokenUsage.totalTokens
      ?? (tokenUsage.totalInputTokens + tokenUsage.totalOutputTokens + tokenUsage.subagentTotalTokens)
    : 0;
  const accounting = tokenUsage?.contextAccounting;

  // 实时 contextUsage 优先。没有实时事件时，仅在服务端明确标记 exact=true
  // 才把 transcript/provider usage 当“当前上下文”显示。Responses 接力场景
  // 上游每轮 usage 仍报全量输入（Ark 实测），同样是 exact，与全量重发场景一视同仁展示。
  const hasRealtime = contextUsage != null && contextUsage.totalTokens > 0;
  const hasContextWindow = hasRealtime
    && typeof contextUsage!.maxTokens === 'number'
    && contextUsage!.maxTokens > 0
    && typeof contextUsage!.percentage === 'number';
  const hasExactFallback = !hasRealtime && accounting?.exact === true && (tokenUsage?.contextTokens ?? 0) > 0;
  const hasExactContext = hasRealtime || hasExactFallback;
  const displayTokens = hasRealtime
    ? contextUsage!.totalTokens
    : hasExactFallback
      ? tokenUsage!.contextTokens
      : cumulativeTokens;
  if (displayTokens === 0) return null;

  // 百分比接近 autoCompactThreshold 时变色预警
  // threshold 未定义时不计算预警（保持中性色），避免用 1 作为默认导致预警色永远不触发
  const percentage = hasContextWindow ? contextUsage!.percentage! : 0;
  const threshold = contextUsage?.autoCompactThreshold;
  const hasThreshold = hasContextWindow && threshold != null;
  const nearThreshold = hasThreshold && percentage >= threshold! * 0.8;
  const overThreshold = hasThreshold && percentage >= threshold!;
  const buttonColor = overThreshold ? 'text-red-600 dark:text-red-400'
    : nearThreshold ? 'text-amber-600 dark:text-amber-400'
    : 'text-muted-foreground';
  const label = (
    <>
      {hasExactContext ? '上下文' : '累计'} {formatTokenCount(displayTokens)}
      {hasContextWindow && ` · ${(percentage * 100).toFixed(0)}%`}
    </>
  );
  const title = hasRealtime && hasContextWindow
    ? `上下文占用：${formatTokenCount(displayTokens)} / ${formatTokenCount(contextUsage!.maxTokens!)} (${(percentage * 100).toFixed(1)}%)`
    : hasRealtime
      ? `当前上下文：${formatTokenCount(displayTokens)}`
    : hasExactFallback
      ? `当前上下文：${formatTokenCount(displayTokens)}（provider usage）`
      : `${accounting?.label ?? '上下文不可确认'}：显示累计用量`;
  const realtimeLastCacheRatio = contextUsage?.lastRequestCacheHitRatio;
  const realtimeCacheRatio = typeof realtimeLastCacheRatio === 'number'
    ? realtimeLastCacheRatio
    : typeof contextUsage?.cacheHitRatio === 'number'
      ? contextUsage.cacheHitRatio
      : undefined;
  const tokenCacheRatio = typeof tokenUsage?.cacheHitRatio === 'number'
    ? tokenUsage.cacheHitRatio
    : undefined;
  const cacheHitRatio = hasRealtime && realtimeCacheRatio !== undefined
    ? realtimeCacheRatio
    : tokenCacheRatio;
  const subagentUsage = tokenUsage?.subagentUsage;
  const parentCumulativeTokens = tokenUsage
    ? Math.max(0, cumulativeTokens - tokenUsage.subagentTotalTokens)
    : 0;

  return (
    <div ref={containerRef} className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
      {allowDetails ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={`whitespace-nowrap rounded-md px-2 py-1 text-xs font-medium tabular-nums transition-colors hover:bg-accent hover:text-accent-foreground ${buttonColor}`}
          title={title}
        >
          {label}
        </button>
      ) : (
        <span
          className={`whitespace-nowrap rounded-md px-2 py-1 text-xs font-medium tabular-nums ${buttonColor}`}
          title={title}
        >
          {label}
        </span>
      )}

      {open && allowDetails && (
        <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded-lg border bg-popover p-3 text-xs shadow-lg">
          {hasRealtime && (
            <>
              <div className="mb-1 font-medium">实时</div>

              {/* 百分比进度条 */}
              {hasContextWindow && (
                <div className="mb-2">
                  <div className="mb-1 flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground">
                      上下文占用 {formatTokenCount(contextUsage!.totalTokens)} / {formatTokenCount(contextUsage!.maxTokens!)}
                    </span>
                    <span className={`font-mono tabular-nums ${buttonColor}`}>
                      {(percentage * 100).toFixed(1)}%
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full transition-all ${overThreshold ? 'bg-red-500' : nearThreshold ? 'bg-amber-500' : 'bg-blue-500'}`}
                      style={{ width: `${Math.min(percentage * 100, 100)}%` }}
                    />
                  </div>
                  {contextUsage!.isAutoCompactEnabled && contextUsage!.autoCompactThreshold != null && (
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      自动压缩阈值：{formatTokenCount(Math.floor(contextUsage!.maxTokens! * contextUsage!.autoCompactThreshold))}
                      （{(contextUsage!.autoCompactThreshold * 100).toFixed(1)}%）
                    </div>
                  )}
                </div>
              )}

              {/* 分类堆叠条 */}
              {contextUsage!.categories.length > 0 && (
                <div className="my-2 space-y-0.5">
                  {contextUsage!.categories
                    .filter((c: ContextUsageData['categories'][number]) => c.tokens > 0)
                    .slice(0, 6)
                    .map((c: ContextUsageData['categories'][number]) => (
                      <div key={c.name} className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="flex items-center gap-1.5 truncate text-muted-foreground">
                          <span className="size-2 rounded-sm" style={{ backgroundColor: c.color }} />
                          {c.name}{c.isDeferred ? ' (deferred)' : ''}
                        </span>
                        <span className="font-mono tabular-nums">{formatTokenCount(c.tokens)}</span>
                      </div>
                    ))}
                </div>
              )}

              {/* memoryFiles */}
              {contextUsage!.memoryFiles.length > 0 && (
                <details className="my-2 text-[11px]">
                  <summary className="cursor-pointer text-muted-foreground">
                    记忆文件 ({contextUsage!.memoryFiles.length})
                  </summary>
                  <div className="mt-1 max-h-32 space-y-0.5 overflow-y-auto pl-2">
                    {contextUsage!.memoryFiles.map((f: ContextUsageData['memoryFiles'][number]) => (
                      <div key={f.path} className="flex items-center justify-between gap-2">
                        <span className="truncate text-muted-foreground" title={f.path}>
                          {f.path.split('/').pop() || f.path}
                        </span>
                        <span className="font-mono tabular-nums">{formatTokenCount(f.tokens)}</span>
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {/* MCP tools */}
              {contextUsage!.mcpTools.length > 0 && (
                <details className="my-2 text-[11px]">
                  <summary className="cursor-pointer text-muted-foreground">
                    MCP 工具 ({contextUsage!.mcpTools.length})
                  </summary>
                  <div className="mt-1 max-h-32 space-y-0.5 overflow-y-auto pl-2">
                    {contextUsage!.mcpTools
                      .slice()
                      .sort(
                        (a: ContextUsageData['mcpTools'][number], b: ContextUsageData['mcpTools'][number]) =>
                          b.tokens - a.tokens,
                      )
                      .slice(0, 20)
                      .map((t: ContextUsageData['mcpTools'][number]) => (
                        <div key={`${t.serverName}:${t.name}`} className="flex items-center justify-between gap-2">
                          <span className="truncate text-muted-foreground" title={`${t.serverName}:${t.name}`}>
                            {t.name}
                          </span>
                          <span className="font-mono tabular-nums">{formatTokenCount(t.tokens)}</span>
                        </div>
                      ))}
                  </div>
                </details>
              )}

              <div className="my-2 border-t" />
            </>
          )}

          {!hasRealtime && hasExactFallback && (
            <>
              <div className="mb-2 rounded-md border bg-muted/35 p-2 text-[10px] leading-snug text-muted-foreground">
                {accounting?.reason ?? '该模型可确认当前上下文口径。'}
              </div>
              <div className="my-2 border-t" />
            </>
          )}

          {!hasExactContext && tokenUsage && (
            <>
              <div className="mb-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/25 dark:text-amber-100">
                <div className="text-[10px] leading-snug opacity-85">
                  {accounting?.reason ?? '当前上下文口径不可确认，以下展示累计用量。'}
                </div>
              </div>
              <div className="my-2 border-t" />
            </>
          )}

          {/* 计费口径（从 transcript 解析） */}
          <div className="space-y-1.5">
            {tokenUsage && (
              <>
                <div className="mb-1 font-medium">父 Agent</div>
                <DetailRow label="上下文" value={formatTokenCount(displayTokens)} />
                <DetailRow label="累计消耗" value={formatTokenCount(parentCumulativeTokens)} />
                <DetailRow label="累计输入" value={tokenUsage.totalInputTokens} />
                <DetailRow label="累计输出" value={tokenUsage.totalOutputTokens} />
                <DetailRow label="缓存读取" value={tokenUsage.totalCacheReadTokens} />
                <DetailRow label="缓存写入" value={tokenUsage.totalCacheCreationTokens} />
                {cacheHitRatio !== undefined && (
                  <DetailRow label="缓存命中率" value={formatPercent(cacheHitRatio)} />
                )}
                {tokenUsage.totalCostUsd != null && tokenUsage.totalCostUsd > 0 && (
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-muted-foreground">
                      {tokenUsage.subagentTotalTokens > 0 ? '父 Agent 等效成本' : '等效成本'}
                    </span>
                    <span className="font-mono tabular-nums">${tokenUsage.totalCostUsd.toFixed(4)}</span>
                  </div>
                )}
                {tokenUsage.subagentTotalTokens > 0 && (
                  <>
                    <div className="my-1.5 border-t" />
                    <div className="mb-1 font-medium">
                      子 Agent{subagentUsage ? `（${subagentUsage.childCount} 个 · ${subagentUsage.requestCount} 次调用）` : ''}
                    </div>
                    <DetailRow label="累计消耗" value={formatTokenCount(tokenUsage.subagentTotalTokens)} />
                    {subagentUsage && (
                      <>
                        <DetailRow label="输入（含缓存）" value={subagentUsage.inputTokens} />
                        <DetailRow label="非缓存输入" value={subagentUsage.uncachedInputTokens} />
                        <DetailRow label="缓存读取" value={subagentUsage.cacheReadTokens} />
                        <DetailRow label="缓存写入（上报）" value={subagentUsage.cacheCreationTokens} />
                        <DetailRow label="输出" value={subagentUsage.outputTokens} />
                        {subagentUsage.cacheHitRatio != null && (
                          <DetailRow label="缓存命中率" value={formatPercent(subagentUsage.cacheHitRatio)} />
                        )}
                        {subagentUsage.cacheCreationTokens === 0 && (
                          <div className="pt-0.5 text-[10px] leading-snug text-muted-foreground">
                            缓存写入为 provider 上报值；0 不代表一定未创建缓存。
                          </div>
                        )}
                      </>
                    )}
                    <div className="my-1.5 border-t" />
                    <DetailRow label="任务总消耗" value={formatTokenCount(cumulativeTokens)} />
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
