/**
 * Token 用量二级页：单用户详情
 *
 * 入口：从 UsageDashboard 用户排行表点击用户名进入
 * 内容：
 *   - 顶部：返回按钮 + 用户标识 + 4 张卡片（总 Token / 总 Cost / 缓存命中率 / Turns）
 *   - 日趋势堆叠柱图（该用户）
 *   - 模型分布柱
 *   - Channel 分布（web / cron）
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

import { useModelDisplayMap } from "@/components/TenantAnalytics/hooks";
import { formatChannel } from "@/components/PlatformAdmin/displayText";

import { usageApi } from "./api";
import type {
  TrendResp,
  ByModelResp,
  ByChannelResp,
  ModelFamily,
} from "./types";
import { formatTokens, formatUsd, formatPercent, formatDateRange } from "./format";
import { TrendChart, type TrendBarDatum } from "./TrendChart";
import { RangeSelector, type RangeQuery, type RangeValue, type CustomRange } from "./RangeSelector";
import { FamilyFilter } from "./FamilyFilter";

interface Props {
  username: string;
  realName?: string;
  tenantId?: string;
  range: RangeValue;
  customRange: CustomRange | null;
  /** 家族筛选；继承自父页 */
  family: ModelFamily | "all";
  onRangeChange: (v: RangeValue, c?: CustomRange) => void;
  onFamilyChange: (v: ModelFamily | "all") => void;
  onBack: () => void;
}

export function UserDetailView({
  username,
  realName,
  tenantId,
  range,
  customRange,
  family,
  onRangeChange,
  onFamilyChange,
  onBack,
}: Props) {
  // 折算成 API 参数：自定义走 from/to，否则走 range；family 始终透传
  const dateArgs = useMemo<{
    range?: RangeQuery;
    from?: string;
    to?: string;
    tenantId?: string;
    family?: ModelFamily;
  }>(() => {
    const familyArg = family === "all" ? undefined : family;
    if (range === "custom" && customRange) {
      return { from: customRange.from, to: customRange.to, tenantId, family: familyArg };
    }
    return { range: range as RangeQuery, tenantId, family: familyArg };
  }, [range, customRange, family, tenantId]);
  const [trend, setTrend] = useState<TrendResp | null>(null);
  const [byModel, setByModel] = useState<ByModelResp | null>(null);
  const [byChannel, setByChannel] = useState<ByChannelResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 客户简化视图：后端剥离成本字段时隐藏 USD 与缓存工程指标；模型名走显示名映射
  const simplified = trend?.costRedacted === true;
  const { labelFor } = useModelDisplayMap();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [tr, bm, bc] = await Promise.all([
        usageApi.trend({ ...dateArgs, username }),
        usageApi.byModel({ ...dateArgs, username }),
        usageApi.byChannel({ ...dateArgs, username }),
      ]);
      setTrend(tr);
      setByModel(bm);
      setByChannel(bc);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [dateArgs, username]);

  useEffect(() => {
    void load();
  }, [load]);

  // 聚合用户期间总计（直接由 trend 累加，省一次 overview 请求）
  const totals = useMemo(() => {
    if (!trend) return null;
    let inTok = 0, outTok = 0, crTok = 0, ccTok = 0, totalTok = 0, cost = 0, turns = 0;
    for (const p of trend.points) {
      inTok += p.inputTokens;
      outTok += p.outputTokens;
      crTok += p.cacheReadTokens;
      ccTok += p.cacheCreationTokens;
      totalTok += p.totalTokens;
      cost += p.costUsd ?? 0;
      turns += p.turns;
    }
    return {
      totalTokens: totalTok,
      ioTokens: inTok + outTok, // 无缓存读写量
      totalCostUsd: cost,
      cacheHitRatio: inTok > 0 ? crTok / inTok : null,
      totalTurns: turns,
    };
  }, [trend]);

  const trendData: TrendBarDatum[] = useMemo(() => {
    if (!trend) return [];
    return trend.points.map((p) => ({
      date: p.date,
      input: p.inputTokens,
      output: p.outputTokens,
      cacheRead: p.cacheReadTokens,
      cacheCreation: p.cacheCreationTokens,
      total: p.totalTokens,
    }));
  }, [trend]);

  const dateRangeLabel = trend ? formatDateRange(trend.fromDate, trend.toDate) : undefined;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onBack}>
            <ArrowLeft className="size-3.5" />
            返回列表
          </Button>
          <h2 className="ml-2 text-lg font-semibold">{realName ?? username}</h2>
          {realName && <span className="text-xs text-muted-foreground">({username})</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <RangeSelector
            value={range}
            customRange={customRange}
            onChange={onRangeChange}
            dateRangeLabel={dateRangeLabel}
          />
          <FamilyFilter value={family} onChange={onFamilyChange} />
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
          加载失败：{error}
        </div>
      )}

      {loading && !trend ? (
        <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" /> 加载中
        </div>
      ) : (
        <>
          {/* 5 卡片 */}
          {totals && (
            <div className={cn("grid grid-cols-2 gap-3 sm:grid-cols-3", simplified ? "lg:grid-cols-3" : "lg:grid-cols-5")}>
              <DetailCard label="总 Token" value={formatTokens(totals.totalTokens)} />
              <DetailCard label="读写量" value={formatTokens(totals.ioTokens)} sub="不含缓存" />
              {!simplified && <DetailCard label="成本" value={formatUsd(totals.totalCostUsd)} sub={totals.totalCostUsd === 0 ? "无数据" : undefined} />}
              {!simplified && <DetailCard label="缓存命中" value={formatPercent(totals.cacheHitRatio)} />}
              <DetailCard label="轮次" value={totals.totalTurns.toLocaleString()} />
            </div>
          )}

          {/* 日趋势 */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">日趋势</CardTitle>
            </CardHeader>
            <CardContent>
              <TrendChart data={trendData} />
            </CardContent>
          </Card>

          {/* 模型分布 + Channel 分布 */}
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">模型分布</CardTitle>
              </CardHeader>
              <CardContent>
                {byModel && byModel.models.length > 0 ? (
                  <ProportionBars
                    rows={byModel.models.map((m) => ({
                      label: labelFor(m.model),
                      tokens: m.totalTokens,
                      cost: m.totalCostUsd,
                      turns: m.totalTurns,
                    }))}
                  />
                ) : (
                  <div className="py-4 text-sm text-muted-foreground">无数据</div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">通道分布</CardTitle>
              </CardHeader>
              <CardContent>
                {byChannel && byChannel.channels.length > 0 ? (
                  <ProportionBars
                    rows={byChannel.channels.map((c) => ({
                      label: formatChannel(c.channel),
                      tokens: c.totalTokens,
                      cost: c.totalCostUsd,
                      turns: c.totalTurns,
                    }))}
                  />
                ) : (
                  <div className="py-4 text-sm text-muted-foreground">无数据</div>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function DetailCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        {sub && <div className="mt-1 truncate text-[11px] text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}

/** 单维度横向占比柱（适用于 model / channel 等）；cost 为 undefined 时（后端脱敏）隐藏成本列 */
function ProportionBars({ rows }: { rows: { label: string; tokens: number; cost?: number; turns: number }[] }) {
  const max = Math.max(...rows.map((r) => r.tokens), 1);
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.label} className="space-y-1">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="truncate font-mono" title={r.label}>{r.label}</span>
            <div className="flex items-center gap-3 text-muted-foreground tabular-nums">
              <span className="font-mono">{formatTokens(r.tokens)}</span>
              {r.cost !== undefined && <span className="w-14 text-right">{formatUsd(r.cost)}</span>}
              <span className="w-10 text-right">{r.turns}</span>
            </div>
          </div>
          <div className="h-2 w-full overflow-hidden rounded bg-muted">
            <div
              className={cn("h-full transition-all", "bg-emerald-500")}
              style={{ width: `${(r.tokens / max) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
