/**
 * 门禁看板（shadow 数据看板 · B4 § 4.4.4 + § 3.2 管理员看板四视图）
 *
 * 4 视图：
 *   1) 拒答 Top：按 message_text 前 24 字聚桶，count DESC 取前 10，含样例
 *   2) Model 分布：主档命中率 / fallback 命中率 / fail-open 侧推
 *   3) Latency：P50 / P90 / P99 + 逐日拒答趋势
 *   4) 申诉队列：pending 申诉列表 + 一键接受/驳回（走 /api/tenant/appeals）
 *
 * 顶部 shadow / enforce / 全部 三档过滤器——语义**完全不同**：shadow 不真拦
 * 只观察，把 shadow 期数据混在一起看会误导决策。
 *
 * 3 个 KPI 卡片（B4 § 4.4.4）：**拒答率 / 申诉率 / fail-open 率**
 */
import { useCallback, useMemo, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { AdminSelect } from '@/components/ui/admin-select';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { HISTORY_PUSH, HISTORY_PUSH_MERGED, useAdminUrlQuery } from '@/hooks/useAdminUrlQuery';
import { cn } from '@/lib/utils';
import type { OrgAgentRecord } from '@agent/shared';
import { useQaAppeals, useQaGuardrailBoard } from './hooks';
import {
  QaFeatureNotDeployedHint,
  QaHorizontalBar,
  QaKpiCard,
  QaMiniBarTrend,
  QaUnavailableHint,
  QaVerdictBadge,
  formatLatencyMs,
  formatPercent,
  formatQaTime,
  orgAgentSelectOptions,
  QaErrorNotice,
} from './shared';
import type { QaGuardrailMode } from './types';

type BoardSubView = 'top' | 'model' | 'latency' | 'appeals';

const SUB_VIEWS: Array<{ id: BoardSubView; label: string; hint: string }> = [
  { id: 'top', label: '拒答 Top', hint: '过去 30 天拒答分类' },
  { id: 'model', label: 'Model 分布', hint: '主档 / fallback / fail-open' },
  { id: 'latency', label: 'Latency', hint: 'P50 / P90 / P99 分布' },
  { id: 'appeals', label: '申诉队列', hint: '员工申诉待处理' },
];

const MODE_TABS: Array<{ id: QaGuardrailMode; label: string; tooltip: string }> = [
  { id: 'all', label: '全部', tooltip: 'shadow + enforce 全部事件' },
  { id: 'shadow', label: '仅看 shadow', tooltip: '门禁判定不生效期观察（新专家上线前 3-7 天）' },
  { id: 'enforce', label: '仅看 enforce', tooltip: '门禁生效的生产判定' },
];

// 分类色板：只用于区分 model，不承载好坏（故不取绿/琥珀/红）
const MODEL_COLORS = [
  'bg-chart-1/70',
  'bg-chart-2/70',
  'bg-chart-3/70',
  'bg-chart-4/70',
  'bg-chart-5/70',
];

/**
 * 由日期字符串（YYYY-MM-DD）反推「过去 N 天」——默认拉 30 天
 * from / to 用 ISO；空则默认 30 天窗口
 */
/** URL 参数契约（客户视图）：`qaBoard*` 前缀，与另外三个子视图分开 */
const BOARD_TAB_KEY = 'qaBoardTab';
const BOARD_MODE_KEY = 'qaBoardMode';
const BOARD_AGENT_KEY = 'qaBoardAgent';
const BOARD_FROM_KEY = 'qaBoardFrom';
const BOARD_TO_KEY = 'qaBoardTo';
const DEFAULT_BOARD_TAB: BoardSubView = 'top';
const DEFAULT_BOARD_MODE: QaGuardrailMode = 'all';
const BOARD_TAB_IDS: ReadonlySet<string> = new Set(SUB_VIEWS.map((item) => item.id));
const BOARD_MODE_IDS: ReadonlySet<string> = new Set(MODE_TABS.map((item) => item.id));

function parseBoardTab(raw: string | null): BoardSubView {
  return raw && BOARD_TAB_IDS.has(raw) ? (raw as BoardSubView) : DEFAULT_BOARD_TAB;
}

function parseBoardMode(raw: string | null): QaGuardrailMode {
  return raw && BOARD_MODE_IDS.has(raw) ? (raw as QaGuardrailMode) : DEFAULT_BOARD_MODE;
}

function defaultDateRange(): { from: string; to: string; fromInput: string; toInput: string } {
  const now = new Date();
  const to = new Date(now);
  const from = new Date(now);
  from.setDate(from.getDate() - 29);
  const iso = (d: Date) => d.toISOString();
  const input = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to), fromInput: input(from), toInput: input(to) };
}

export function GuardrailBoardView({ tenantId, orgAgents }: { tenantId?: string; orgAgents: OrgAgentRecord[] }) {
  const url = useAdminUrlQuery();
  const subView = parseBoardTab(url.get(BOARD_TAB_KEY));
  const mode = parseBoardMode(url.get(BOARD_MODE_KEY));
  const orgAgentId = url.get(BOARD_AGENT_KEY) ?? '';
  // 默认 30 天窗口仍然是算出来的（不写进 URL，保持链接短）；URL 上有值时以 URL 为准
  const initial = useMemo(defaultDateRange, []);
  const startDate = url.get(BOARD_FROM_KEY) ?? initial.fromInput;
  const endDate = url.get(BOARD_TO_KEY) ?? initial.toInput;
  const setSubView = useCallback(
    (next: BoardSubView) => url.set(BOARD_TAB_KEY, next === DEFAULT_BOARD_TAB ? null : next, HISTORY_PUSH),
    [url],
  );
  const setMode = useCallback(
    (next: QaGuardrailMode) => url.set(BOARD_MODE_KEY, next === DEFAULT_BOARD_MODE ? null : next, HISTORY_PUSH),
    [url],
  );
  const setOrgAgentId = useCallback((value: string) => url.set(BOARD_AGENT_KEY, value || null, HISTORY_PUSH), [url]);
  const setStartDate = useCallback((value: string) => url.set(BOARD_FROM_KEY, value || null, HISTORY_PUSH_MERGED), [url]);
  const setEndDate = useCallback((value: string) => url.set(BOARD_TO_KEY, value || null, HISTORY_PUSH_MERGED), [url]);

  const from = startDate ? new Date(startDate).toISOString() : undefined;
  const to = endDate ? new Date(`${endDate}T23:59:59.999Z`).toISOString() : undefined;

  const boardParams = useMemo(
    () => ({ tenantId, orgAgentId: orgAgentId || undefined, mode, from, to }),
    [tenantId, orgAgentId, mode, from, to],
  );

  const { board, loading, error, availability, truncated, refresh } = useQaGuardrailBoard(boardParams);
  const appeals = useQaAppeals(useMemo(
    () => ({ tenantId, orgAgentId: orgAgentId || undefined }),
    [tenantId, orgAgentId],
  ));
  const agentNameById = useMemo(() => new Map(orgAgents.map((a) => [a.id, a.name])), [orgAgents]);

  /**
   * 看板 → 门禁日志（只看拒答）。
   *
   * 一次 patch 同时改视图与筛选，而不是「先切视图再设筛选」两次写 URL：
   * 分两步写会让门禁日志先用旧筛选拉一次数据，白跑一个请求还会闪一下旧结果。
   *
   * 时间范围只在用户显式改过（URL 上有值）时才带过去。看板默认 30 天窗口是算出来的、
   * 不写 URL，硬塞过去会让门禁日志显示一个用户从没选过的日期区间。
   */
  const viewRejectionLogs = useCallback(() => {
    url.patch({
      qaView: 'guardrail',
      qaLogResult: 'off_topic',
      qaLogAgent: orgAgentId || null,
      qaLogFrom: url.get(BOARD_FROM_KEY),
      qaLogTo: url.get(BOARD_TO_KEY),
    }, HISTORY_PUSH);
  }, [orgAgentId, url]);

  if (availability === 'unavailable') return <QaUnavailableHint />;

  const pendingAppeals = appeals.items.filter((a) => a.status === 'pending').length;
  const appealsUnavailable = appeals.availability === 'unavailable';

  // KPI 口径（B4 § 4.4.4）：
  //   拒答率 = off_topic / total（本 board 已按 mode 过滤）
  //   申诉率 = appeals_pending / off_topic（申诉端点未部署时不显示分子）
  //   fail-open 率：MVP 阶段无直接口径（需从 runtime_token_usage channel='guardrail' 侧推），
  //                 前端暂用「无 model 字段的比例」占位——0% 时表示所有事件都记录了 model
  const hasGuardrailSamples = board.total > 0;
  const hasAppealSamples = board.offTopicCount > 0;
  const rejectRate = hasGuardrailSamples ? board.offTopicCount / board.total : 0;
  const appealRate = hasAppealSamples && !appealsUnavailable
    ? pendingAppeals / board.offTopicCount
    : 0;
  const failOpenProxy = hasGuardrailSamples
    ? board.total - board.modelBreakdown.reduce((s, m) => s + m.count, 0)
    : 0;
  const failOpenRate = hasGuardrailSamples ? failOpenProxy / board.total : 0;

  return (
    <div className="w-full space-y-4">
      {/* shadow / enforce / 全部 模式切换 —— 三档语义不同，必须显眼 */}
      <div className="flex items-center gap-2" role="tablist" aria-label="门禁模式">
        {MODE_TABS.map((tab) => (
          <Button
            key={tab.id}
            type="button"
            size="sm"
            variant={mode === tab.id ? 'default' : 'outline'}
            onClick={() => setMode(tab.id)}
            className="h-8 gap-1.5 px-3 text-xs"
            title={tab.tooltip}
            role="tab"
            aria-selected={mode === tab.id}
          >
            {tab.label}
          </Button>
        ))}
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          {/*
            这块徽章之下的三个 KPI 与四个子视图**全部**基于被截断的 200 条样本算出来的。
            改造前只有「近 200 条估算」四个字、无任何解释，用户不会知道自己看的是抽样。
          */}
          {truncated && (
            <Badge
              variant="warning"
              title="当前范围记录数超过 200 条，页面上的比率与分布基于最近 200 条抽样计算，不是全量精确值。缩小时间范围可得到精确结果。"
            >
              近 200 条估算
            </Badge>
          )}
          <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
            <RefreshCw className={cn('mr-2 size-3.5', loading && 'animate-spin')} />刷新
          </Button>
        </div>
      </div>

      {/* KPI 3 卡（B4 § 4.4.4 拒答率 / 申诉率 / fail-open 率） */}
      <div className="grid gap-3 md:grid-cols-3">
        <QaKpiCard
          label="拒答率"
          value={hasGuardrailSamples ? formatPercent(rejectRate) : '-'}
          hint={hasGuardrailSamples ? `off_topic ${board.offTopicCount} / total ${board.total}` : '无样本'}
          intent={rejectRate > 0.3 ? 'warning' : 'default'}
        />
        <QaKpiCard
          label="申诉率"
          value={appealsUnavailable ? '未部署' : hasAppealSamples ? formatPercent(appealRate) : '-'}
          hint={
            appealsUnavailable
              ? '/api/tenant/appeals 未装配'
              : hasAppealSamples
                ? `pending ${pendingAppeals} / off_topic ${board.offTopicCount}`
                : '无样本'
          }
          intent={appealRate > 0.05 ? 'warning' : 'default'}
        />
        <QaKpiCard
          label="fail-open 率"
          value={hasGuardrailSamples ? formatPercent(failOpenRate) : '-'}
          hint={hasGuardrailSamples ? '无 model 字段事件的占比（近似口径）' : '无样本'}
          intent={failOpenRate > 0.05 ? 'warning' : 'default'}
        />
      </div>

      {/* 过滤器（专家 / 日期）—— 时间默认最近 30 天 */}
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3">
          <CardTitle className="text-base">筛选条件</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          <div className="space-y-1.5">
            <Label>企业专家</Label>
            <AdminSelect
              ariaLabel="企业专家"
              size="md"
              className="w-full"
              options={orgAgentSelectOptions(orgAgents)}
              value={orgAgentId}
              onValueChange={setOrgAgentId}
            />
          </div>
          <div className="space-y-1.5">
            <Label>开始日期</Label>
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>结束日期</Label>
            <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      {error && <QaErrorNotice error={error} onRetry={refresh} />}

      {/* 4 视图子 tab */}
      <nav className="flex items-center gap-1 border-b" aria-label="门禁看板子视图">
        {SUB_VIEWS.map((item) => {
          const selected = item.id === subView;
          const badge = item.id === 'appeals' && !appealsUnavailable && pendingAppeals > 0
            ? ` (${pendingAppeals})`
            : '';
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setSubView(item.id)}
              className={cn(
                'flex flex-col items-start gap-0.5 border-b-2 px-3 py-2 text-xs transition-colors',
                selected
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
              aria-selected={selected}
              role="tab"
            >
              <span className="font-medium">{item.label}{badge}</span>
              <span className="text-2xs text-muted-foreground">{item.hint}</span>
            </button>
          );
        })}
      </nav>

      {loading && board.total === 0 ? (
        <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" />加载门禁数据...
        </div>
      ) : (
        <div>
          {subView === 'top' && (
            <TopRejectionsView
              board={board}
              agentNameById={agentNameById}
              onViewRejectionLogs={board.offTopicCount > 0 ? viewRejectionLogs : undefined}
            />
          )}
          {subView === 'model' && <ModelBreakdownView board={board} />}
          {subView === 'latency' && <LatencyView board={board} />}
          {subView === 'appeals' && (
            appealsUnavailable ? (
              <QaFeatureNotDeployedHint
                title="申诉处理暂未开放"
                hint="当前部署尚未启用申诉功能，如需使用请联系管理员。"
              />
            ) : (
              <AppealsView
                appeals={appeals.items}
                loading={appeals.loading}
                error={appeals.error}
                agentNameById={agentNameById}
                onHandle={appeals.handle}
              />
            )
          )}
        </div>
      )}
    </div>
  );
}

// ---------- 视图 1 · 拒答 Top ----------

function TopRejectionsView({
  board,
  agentNameById: _agentNameById,
  onViewRejectionLogs,
}: {
  board: ReturnType<typeof useQaGuardrailBoard>['board'];
  agentNameById: Map<string, string>;
  /** 跳到门禁日志并只看拒答。undefined 表示宿主没提供子视图切换，此时不渲染入口 */
  onViewRejectionLogs?: () => void;
}) {
  if (board.topRejections.length === 0) {
    return <EmptyBlock>当前范围暂无门禁日志数据</EmptyBlock>;
  }
  const totalTop = board.topRejections.reduce((sum, item) => sum + item.count, 0);
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <CardTitle className="text-base">按 message 类型 Top 10（{board.offTopicCount} 拒答 · {board.passFlaggedCount} 放行打标）</CardTitle>
        {/*
          改造前这一屏是死路：看到拒答分布，没有任何入口去看具体记录。

          注意措辞——门禁日志只支持按专家/判定/日期筛选，**没有按 message 文本筛的参数**，
          所以跳过去是「这段时间的全部拒答」而不是「这一类拒答」。文案必须说清楚，
          否则用户会以为筛的是自己刚点的那一类。
        */}
        {onViewRejectionLogs && (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={onViewRejectionLogs}
            title="按当前专家与时间范围，查看全部拒答明细"
          >
            查看拒答明细
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {board.topRejections.map((item, idx) => (
          <div key={item.bucket + idx} className="space-y-1.5">
            <QaHorizontalBar
              label={item.bucket}
              count={item.count}
              total={totalTop}
              suffix={`${item.count} · 拒 ${item.offTopic} / 打标 ${item.passFlagged}`}
              color={item.offTopic > item.passFlagged ? 'bg-danger/70' : 'bg-warning/70'}
            />
            {item.sampleTexts.length > 0 && (
              <ul className="ml-2 space-y-0.5 text-xs text-muted-foreground">
                {item.sampleTexts.slice(0, 2).map((sample, i) => (
                  <li key={i} className="truncate" title={sample}>· {sample}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ---------- 视图 2 · Model 分布 ----------

function ModelBreakdownView({ board }: { board: ReturnType<typeof useQaGuardrailBoard>['board'] }) {
  const total = board.modelBreakdown.reduce((sum, item) => sum + item.count, 0);
  if (total === 0) {
    return <EmptyBlock>无模型调用记录</EmptyBlock>;
  }
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Model 调用分布（{total} 次）</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {board.modelBreakdown.map((item, idx) => (
            <QaHorizontalBar
              key={item.model}
              label={item.model}
              count={item.count}
              total={total}
              color={MODEL_COLORS[idx % MODEL_COLORS.length]}
              suffix={`${item.count} · ${formatPercent(item.ratio)}`}
            />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">主档 / Fallback</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 md:grid-cols-2">
            <QaKpiCard
              label="主档命中"
              value={board.modelBreakdown[0]
                ? formatPercent(board.modelBreakdown[0].ratio)
                : '-'}
              hint={board.modelBreakdown[0]?.model ?? '无数据'}
              intent="success"
            />
            <QaKpiCard
              label="Fallback 命中率"
              value={formatPercent(board.fallbackHitRate)}
              hint={board.fallbackHitRate > 0.05 ? '> 5% 需排查主档失败原因' : '主档运转正常'}
              intent={board.fallbackHitRate > 0.05 ? 'warning' : 'default'}
            />
          </div>
          <div className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
            <div className="font-medium text-foreground">口径说明</div>
            <div>· 主档 = 调用量最高的 model（生产接线约定 doubao-1.5-lite）</div>
            <div>· fallback 命中率 = 非主档调用 / 总调用（含 gpt-4o-mini / glm-4-flash）</div>
            <div>· fail-open 率见顶部 KPI 卡（无 model 事件的近似口径）</div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------- 视图 3 · Latency ----------

function LatencyView({ board }: { board: ReturnType<typeof useQaGuardrailBoard>['board'] }) {
  const p95Warning = (board.latency.p90 ?? 0) > 2000; // 用 P90 近似 P95 阈值
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">延迟分位数（{board.latency.samples} 采样）</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 md:grid-cols-3">
            <QaKpiCard label="P50" value={formatLatencyMs(board.latency.p50)} />
            <QaKpiCard
              label="P90"
              value={formatLatencyMs(board.latency.p90)}
              intent={p95Warning ? 'warning' : 'default'}
              hint={p95Warning ? 'P90 > 2s 建议排查' : undefined}
            />
            <QaKpiCard label="P99" value={formatLatencyMs(board.latency.p99)} />
          </div>
          <div className="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
            门禁调用直挂在聊天链路上，P90 &gt; 2s 会显著影响首字延迟——考虑切主档
            或缩短 scopeDescription。
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">逐日拒答趋势</CardTitle>
        </CardHeader>
        <CardContent>
          <QaMiniBarTrend
            points={board.dailyCounts.map((d) => ({ date: d.date, value: d.count }))}
            emptyText="窗口内无门禁事件"
          />
        </CardContent>
      </Card>
    </div>
  );
}

// ---------- 视图 4 · 申诉队列 ----------

function AppealsView({
  appeals,
  loading,
  error,
  agentNameById,
  onHandle,
}: {
  appeals: ReturnType<typeof useQaAppeals>['items'];
  loading: boolean;
  error: string | null;
  agentNameById: Map<string, string>;
  onHandle: (id: string, action: 'accept' | 'reject', note?: string) => Promise<void>;
}) {
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function act(id: string, action: 'accept' | 'reject') {
    setProcessingId(id);
    setActionError(null);
    try {
      await onHandle(id, action);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setProcessingId(null);
    }
  }

  if (loading && appeals.length === 0) {
    return (
      <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />加载申诉队列...
      </div>
    );
  }
  if (error) {
    return <QaErrorNotice error={error} />;
  }
  if (appeals.length === 0) {
    return <EmptyBlock>当前范围无申诉记录</EmptyBlock>;
  }

  return (
    <div className="space-y-3">
      {actionError && (
        <QaErrorNotice error={actionError} />
      )}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>时间</TableHead>
                <TableHead>员工</TableHead>
                <TableHead>企业专家</TableHead>
                <TableHead>门禁判定</TableHead>
                <TableHead>员工消息</TableHead>
                <TableHead>申诉理由</TableHead>
                <TableHead>状态 / 操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {appeals.map((appeal) => {
                const isProcessing = processingId === appeal.id;
                return (
                  <TableRow key={appeal.id}>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatQaTime(appeal.createdAt)}</TableCell>
                    <TableCell className="text-sm">{appeal.username || appeal.userId}</TableCell>
                    <TableCell className="text-sm">{agentNameById.get(appeal.orgAgentId) || appeal.orgAgentId}</TableCell>
                    <TableCell><QaVerdictBadge verdict={appeal.verdict} /></TableCell>
                    <TableCell className="max-w-xs truncate text-sm" title={appeal.messageText}>{appeal.messageText}</TableCell>
                    <TableCell className="max-w-xs truncate text-sm text-muted-foreground" title={appeal.reason}>{appeal.reason}</TableCell>
                    <TableCell>
                      {appeal.status === 'pending' ? (
                        <div className="flex items-center gap-1.5">
                          <Button
                            type="button"
                            size="sm"
                            variant="default"
                            disabled={isProcessing}
                            onClick={() => act(appeal.id, 'accept')}
                            className="h-7 px-2 text-xs"
                          >
                            {isProcessing ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}接受
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={isProcessing}
                            onClick={() => act(appeal.id, 'reject')}
                            className="h-7 px-2 text-xs"
                          >
                            拒绝
                          </Button>
                        </div>
                      ) : appeal.status === 'accepted' ? (
                        <Badge variant="success">已接受</Badge>
                      ) : (
                        <Badge className="border-0 bg-muted text-muted-foreground">已拒绝</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function EmptyBlock({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
