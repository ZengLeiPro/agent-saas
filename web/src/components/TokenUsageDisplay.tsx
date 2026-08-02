import { useState, useRef, useEffect } from "react";
import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import type { TokenUsage } from "@/lib/sessionsApi";
import type { ContextUsageCategory, ContextUsageData, MessageItem, SubagentStatus } from "@agent/shared";
import { formatTokenCount } from "@/lib/sessionsApi";

interface TokenUsageDisplayProps {
  tokenUsage: TokenUsage | null;
  /** SDK 0.2.112+ 实时推送的上下文占用细分，优先于 tokenUsage 展示 */
  contextUsage?: ContextUsageData | null;
  /** 租户模型策略：是否允许点击展开 Token 明细。 */
  allowDetails?: boolean;
  messages?: MessageItem[];
  onOpenChildSession?: (sessionId: string) => void;
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

function AccuracyBadge({ accuracy }: { accuracy: ContextUsageCategory['accuracy'] }) {
  const label = accuracy === 'provider' ? '实际' : accuracy === 'derived' ? '差额' : '校准估算';
  return (
    <span className="rounded-full bg-muted px-1.5 py-px text-[9px] font-medium text-muted-foreground">
      {label}
    </span>
  );
}

interface ChildAgentResource {
  childSessionId: string;
  agentType: string;
  status: SubagentStatus;
  model?: string;
  durationMs?: number;
  totalTokens?: number;
}

function collectChildAgentResources(messages: MessageItem[] | undefined): ChildAgentResource[] {
  if (!messages?.length) return [];
  const bySession = new Map<string, ChildAgentResource>();
  for (const message of messages) {
    if (message.type !== 'subagent' || !message.childSessionId) continue;
    bySession.set(message.childSessionId, {
      childSessionId: message.childSessionId,
      agentType: message.agentType,
      status: message.status,
      model: message.model,
      durationMs: message.durationMs,
      totalTokens: message.totalTokens,
    });
  }
  return [...bySession.values()];
}

function childStatusLabel(status: SubagentStatus): string {
  if (status === 'running') return '运行中';
  if (status === 'completed') return '已完成';
  if (status === 'cancelled') return '已取消';
  if (status === 'timeout') return '超时';
  return '失败';
}

/** 上下文构成的横向堆叠彩条：按类目占比复用各自 color，替代纯列表的"只有小色点"。 */
function StackedBar({ segments }: { segments: Array<{ key: string; name: string; tokens: number; color: string }> }) {
  const shown = segments.filter((segment) => segment.tokens > 0);
  const total = shown.reduce((sum, segment) => sum + segment.tokens, 0);
  if (total <= 0) return null;
  return (
    <div className="mt-2.5 flex h-2.5 w-full overflow-hidden rounded-full bg-muted">
      {shown.map((segment) => (
        <div
          key={segment.key}
          title={`${segment.name} ${formatTokenCount(segment.tokens)}`}
          style={{ width: `${(segment.tokens / total) * 100}%`, backgroundColor: segment.color }}
        />
      ))}
    </div>
  );
}

function CategoryTree({ categories, depth = 0 }: { categories: ContextUsageCategory[]; depth?: number }) {
  return (
    <div className={depth > 0 ? "ml-3 border-l border-border/60 pl-2" : ""}>
      {categories.filter((item) => item.tokens > 0).map((item) => (
        <div key={item.key} className="py-1">
          <div className="flex items-center justify-between gap-2 text-[12px]">
            <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
              <span className="size-2 shrink-0 rounded-sm" style={{ backgroundColor: item.color }} />
              <span className="truncate" title={item.name}>{item.name}</span>
              {item.isDeferred && <span className="text-[9px]">deferred</span>}
              <AccuracyBadge accuracy={item.accuracy} />
            </span>
            <span className="shrink-0 font-mono tabular-nums">{formatTokenCount(item.tokens)}</span>
          </div>
          {item.children?.length ? <CategoryTree categories={item.children} depth={depth + 1} /> : null}
        </div>
      ))}
    </div>
  );
}

/** 记忆文件 / MCP 工具等次要清单的统一折叠节，替代样式无法控制的原生 details/summary。 */
function CollapsibleSection({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="px-3 py-2.5">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center justify-between gap-2 rounded-md text-left"
        aria-expanded={expanded}
      >
        <span className="text-[13px] font-medium">
          {title}
          <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">({count})</span>
        </span>
        <ChevronDown
          className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>
      {expanded && (
        <div className="mt-2 max-h-40 space-y-1 overflow-y-auto text-[11px]">{children}</div>
      )}
    </div>
  );
}

export function TokenUsageDisplay({
  tokenUsage,
  contextUsage,
  allowDetails = false,
  messages,
  onOpenChildSession,
}: TokenUsageDisplayProps) {
  const [open, setOpen] = useState(false);
  const childAgents = collectChildAgentResources(messages);
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
  const buttonColor = overThreshold ? 'text-rose-600 dark:text-rose-400'
    : nearThreshold ? 'text-amber-600 dark:text-amber-400'
    : 'text-muted-foreground';
  const label = (
    <>
      {hasExactContext ? formatTokenCount(displayTokens) : `累计 ${formatTokenCount(displayTokens)}`}
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

  // Hero 卡：百分比大数字 + 进度条的状态色，与积分弹窗预算条同一套语义
  const heroPercentColor = overThreshold ? 'text-rose-600 dark:text-rose-400'
    : nearThreshold ? 'text-amber-600 dark:text-amber-400'
    : 'text-foreground';
  const barColor = overThreshold ? 'bg-rose-500' : nearThreshold ? 'bg-amber-500' : 'bg-brand-500';
  const thresholdTokens = hasThreshold ? Math.floor(contextUsage!.maxTokens! * threshold!) : 0;
  const breakdown = hasRealtime ? contextUsage!.breakdown : undefined;

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
        <div className="absolute right-0 top-full z-50 mt-2 max-h-[75vh] w-96 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-[20px] border bg-popover p-2 text-xs text-popover-foreground shadow-[0_18px_50px_rgba(15,23,42,0.16)]">
          {/* Hero 卡：用户点「上下文」最关心的信息放第一屏 */}
          {hasExactContext ? (
            <div className="rounded-2xl border border-border/80 bg-muted/35 p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold">当前上下文</span>
                <span className="rounded-full bg-background px-2.5 py-1 text-[11px] font-medium text-muted-foreground shadow-sm">
                  {hasRealtime ? '实际值' : 'provider usage'}
                </span>
              </div>
              {hasContextWindow ? (
                <>
                  <div className="mt-3 flex items-baseline gap-2">
                    <span className={`text-2xl font-semibold leading-none tabular-nums ${heroPercentColor}`}>
                      {(percentage * 100).toFixed(1)}%
                    </span>
                    <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                      {formatTokenCount(displayTokens)} / {formatTokenCount(contextUsage!.maxTokens!)}
                    </span>
                  </div>
                  <div className="relative mt-2.5 h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full rounded-full transition-[width] ${barColor}`}
                      style={{ width: `${Math.min(percentage * 100, 100)}%` }}
                    />
                    {hasThreshold && (
                      <div
                        className="absolute inset-y-0 w-px bg-foreground/40"
                        style={{ left: `${Math.min(threshold! * 100, 100)}%` }}
                        title={`自动压缩阈值 ${formatTokenCount(thresholdTokens)}`}
                      />
                    )}
                  </div>
                  {hasThreshold && contextUsage!.isAutoCompactEnabled && (
                    <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground/80">
                      自动压缩阈值 {formatTokenCount(thresholdTokens)}（{(threshold! * 100).toFixed(0)}%）
                      {overThreshold
                        ? ' · 已达阈值，即将自动压缩'
                        : ` · 距压缩还剩 ${formatTokenCount(Math.max(0, thresholdTokens - displayTokens))}`}
                    </p>
                  )}
                </>
              ) : (
                <div className="mt-3 flex items-baseline gap-2">
                  <span className="text-2xl font-semibold leading-none tabular-nums">
                    {formatTokenCount(displayTokens)}
                  </span>
                  <span className="text-xs text-muted-foreground">tokens</span>
                </div>
              )}
              {hasExactFallback && accounting?.reason && (
                <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground/80">{accounting.reason}</p>
              )}
            </div>
          ) : (
            <div className="rounded-2xl border border-border/80 bg-muted/35 p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold">累计用量</span>
                <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
                  口径不可确认
                </span>
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="text-2xl font-semibold leading-none tabular-nums">
                  {formatTokenCount(displayTokens)}
                </span>
                <span className="text-xs text-muted-foreground">tokens</span>
              </div>
              <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground/80">
                {accounting?.reason ?? '当前上下文口径不可确认，以上展示累计用量。'}
              </p>
            </div>
          )}

          <div className="divide-y divide-border/60">
            {/* 上下文构成：堆叠彩条 + 类目树 */}
            {breakdown?.categories.length ? (
              <div className="px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[13px] font-medium">上下文构成</span>
                  <span className="text-[10px] text-muted-foreground">
                    原始估算 {formatTokenCount(breakdown.estimatedTokens)}
                    {breakdown.providerContextTokens != null
                      ? ` / 校准总量 ${formatTokenCount(breakdown.providerContextTokens)}`
                      : ''}
                  </span>
                </div>
                <StackedBar segments={breakdown.categories} />
                <div className="mt-1.5">
                  <CategoryTree categories={breakdown.categories} />
                </div>
                <p className="mt-1.5 text-[10px] leading-relaxed text-muted-foreground/80">
                  总量为 provider 实际值 · 构成按估算占比校准
                </p>
              </div>
            ) : hasRealtime && contextUsage!.categories.length > 0 ? (
              <div className="px-3 py-3">
                <div className="text-[13px] font-medium">上下文构成</div>
                <StackedBar
                  segments={contextUsage!.categories.map((c: ContextUsageData['categories'][number]) => ({
                    key: c.name,
                    name: c.name,
                    tokens: c.tokens,
                    color: c.color,
                  }))}
                />
                <div className="mt-1.5 space-y-1">
                  {contextUsage!.categories
                    .filter((c: ContextUsageData['categories'][number]) => c.tokens > 0)
                    .slice(0, 8)
                    .map((c: ContextUsageData['categories'][number]) => (
                      <div key={c.name} className="flex items-center justify-between gap-2 text-[12px]">
                        <span className="flex items-center gap-1.5 truncate text-muted-foreground">
                          <span className="size-2 rounded-sm" style={{ backgroundColor: c.color }} />
                          {c.name}{c.isDeferred ? ' (deferred)' : ''}
                        </span>
                        <span className="font-mono tabular-nums">{formatTokenCount(c.tokens)}</span>
                      </div>
                    ))}
                </div>
              </div>
            ) : null}

            {/* 累计模型用量 */}
            {hasRealtime && contextUsage!.usageTotals && (
              <div className="px-3 py-3">
                <div className="text-[13px] font-medium">累计模型用量</div>
                <div className="mt-2.5 space-y-1.5 text-[12px]">
                  <DetailRow label="输入 Token" value={contextUsage!.usageTotals.inputTokens} />
                  <DetailRow label="未缓存输入" value={contextUsage!.usageTotals.uncachedInputTokens} />
                  <DetailRow label="缓存命中" value={contextUsage!.usageTotals.cacheReadTokens} />
                  <DetailRow label="缓存写入" value={contextUsage!.usageTotals.cacheCreationTokens} />
                  <DetailRow label="输出 Token" value={contextUsage!.usageTotals.outputTokens} />
                  {contextUsage!.usageTotals.reasoningTokens > 0 && (
                    <DetailRow label="思考 Token" value={contextUsage!.usageTotals.reasoningTokens} />
                  )}
                </div>
              </div>
            )}

            {/* 父 Agent */}
            {tokenUsage && (
              <div className="px-3 py-3">
                <div className="text-[13px] font-medium">父 Agent</div>
                <div className="mt-2.5 space-y-1.5 text-[12px]">
                  {hasExactContext && <DetailRow label="上下文" value={formatTokenCount(displayTokens)} />}
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
                </div>
              </div>
            )}

            {/* 子 Agent + 任务总消耗 */}
            {tokenUsage && tokenUsage.subagentTotalTokens > 0 && (
              <div className="px-3 py-3">
                <div className="text-[13px] font-medium">
                  子 Agent{subagentUsage ? `（${subagentUsage.childCount} 个 · ${subagentUsage.requestCount} 次调用）` : ''}
                </div>
                <div className="mt-2.5 space-y-1.5 text-[12px]">
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
                        <p className="pt-0.5 text-[10px] leading-relaxed text-muted-foreground/80">
                          缓存写入为 provider 上报值；0 不代表一定未创建缓存。
                        </p>
                      )}
                    </>
                  )}
                </div>
                <div className="mt-2.5 flex items-center justify-between gap-4 border-t border-border/60 pt-2.5 text-[12px] font-medium">
                  <span>任务总消耗</span>
                  <span className="font-mono tabular-nums">{formatTokenCount(cumulativeTokens)}</span>
                </div>
              </div>
            )}

            {/* 子任务资源 */}
            {childAgents.length > 0 && (
              <div className="px-3 py-3">
                <div className="text-[13px] font-medium">子任务资源</div>
                <div className="mt-1.5 space-y-0.5">
                  {childAgents.map((child) => (
                    <button
                      type="button"
                      key={child.childSessionId}
                      onClick={() => onOpenChildSession?.(child.childSessionId)}
                      disabled={!onOpenChildSession}
                      className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] transition-colors enabled:hover:bg-muted"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{child.agentType}</span>
                        <span className="block truncate text-[10px] text-muted-foreground">
                          {childStatusLabel(child.status)}
                          {child.model ? ` · ${child.model}` : ''}
                          {typeof child.durationMs === 'number' ? ` · ${(child.durationMs / 1000).toFixed(1)}s` : ''}
                        </span>
                      </span>
                      <span className="shrink-0 font-mono tabular-nums">
                        {typeof child.totalTokens === 'number' ? formatTokenCount(child.totalTokens) : '—'}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* 记忆文件 */}
            {hasRealtime && contextUsage!.memoryFiles.length > 0 && (
              <CollapsibleSection title="记忆文件" count={contextUsage!.memoryFiles.length}>
                {contextUsage!.memoryFiles.map((f: ContextUsageData['memoryFiles'][number]) => (
                  <div key={f.path} className="flex items-center justify-between gap-2">
                    <span className="truncate text-muted-foreground" title={f.path}>
                      {f.path.split('/').pop() || f.path}
                    </span>
                    <span className="font-mono tabular-nums">{formatTokenCount(f.tokens)}</span>
                  </div>
                ))}
              </CollapsibleSection>
            )}

            {/* MCP tools */}
            {hasRealtime && contextUsage!.mcpTools.length > 0 && (
              <CollapsibleSection title="MCP 工具" count={contextUsage!.mcpTools.length}>
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
                        {t.serverName} / {t.name}{t.isLoaded === false ? ' (deferred)' : ''}
                      </span>
                      <span className="font-mono tabular-nums">{formatTokenCount(t.tokens)}</span>
                    </div>
                  ))}
                {contextUsage!.mcpTools.length > 20 && (
                  <p className="pt-1 text-[10px] text-muted-foreground/70">仅显示 Token 占用前 20 项</p>
                )}
              </CollapsibleSection>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
