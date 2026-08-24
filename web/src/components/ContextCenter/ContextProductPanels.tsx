import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, FileSearch, Loader2, RefreshCw, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

import { EvidenceReferenceDrawer } from "./EvidenceReferenceDrawer";
import type {
  ContextCenterApiPort,
  ContextCorrectionRecord,
  ContextDerivedItem,
  ContextEntity,
  ContextEntityDetail,
  ContextEntityProfile,
  ContextEvidenceRef,
  ContextProfileFacetType,
  ContextPage,
  ContextRelation,
  ContextReviewItem,
  ContextTimelineItem,
  RelationLevel,
  RelationReviewStatus,
} from "./types";

const FACETS: Array<{ type: ContextProfileFacetType; label: string }> = [
  { type: "role", label: "角色 Role" },
  { type: "tasks", label: "任务 Tasks" },
  { type: "workflow", label: "工作流 Workflow" },
  { type: "artifacts", label: "产物 Artifacts" },
  { type: "knowhow", label: "诀窍 Know-how" },
];

const RELATION_LABEL: Record<RelationLevel, string> = {
  explicit: "explicit · 明确",
  cooccurrence: "cooccurrence · 共现",
  inferred: "inferred · 推断",
};

const RELATION_REVIEW_LABEL: Record<RelationReviewStatus, string> = {
  proposed: "proposed · 待确认",
  confirmed: "confirmed · 已确认",
  rejected: "rejected · 已拒绝",
};

function formatDateTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(timestamp));
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "请求失败，请稍后重试";
}

function StateFrame({ loading, error, empty, onRetry, children }: {
  loading: boolean; error: string | null; empty: boolean; onRetry: () => void; children: React.ReactNode;
}) {
  if (loading) return <div className="flex min-h-52 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />正在加载</div>;
  if (error) return <div role="alert" className="flex min-h-52 flex-col items-center justify-center gap-3 rounded-xl border border-danger/30 bg-danger/5 p-6 text-center"><TriangleAlert className="size-7 text-danger-ink" /><p className="text-sm text-danger-ink">{error}</p><Button variant="outline" size="sm" onClick={onRetry}>重试</Button></div>;
  if (empty) return <div className="min-h-52 rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground"><FileSearch className="mx-auto mb-2 size-8" />暂无符合条件的数据</div>;
  return <>{children}</>;
}

function Degraded({ show, exhausted = false }: { show: boolean; exhausted?: boolean }) {
  return show ? <div role="status" aria-live="polite" className="mb-3 flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning-ink"><TriangleAlert className="size-4" /><span>当前结果为降级数据，可能不完整；请结合 Evidence 判断。{exhausted ? " 已达后端候选上限，无更多结果可加载。" : ""}</span></div> : null;
}

function appendPage<T extends { id: string }>(current: ContextPage<T>, next: ContextPage<T>): ContextPage<T> {
  return {
    ...next,
    items: [...new Map([...current.items, ...next.items].map(item => [item.id, item])).values()],
    degraded: current.degraded || next.degraded,
  };
}

function LoadMore({ cursor, busy, error, onLoad, label = "加载更多" }: { cursor: string | null | undefined; busy: boolean; error: string | null; onLoad: (cursor: string) => void; label?: string }) {
  if (!cursor && !error) return null;
  return <div className="mt-3 flex flex-wrap items-center gap-3">
    {cursor && <Button variant="outline" disabled={busy} onClick={() => onLoad(cursor)}>{busy ? <><Loader2 className="mr-1.5 size-4 animate-spin" />加载中</> : label}</Button>}
    {error && <span role="alert" className="flex items-center gap-2 text-sm text-danger-ink">加载更多失败：{error}{cursor && <Button variant="ghost" size="sm" disabled={busy} onClick={() => onLoad(cursor)}>重试</Button>}</span>}
  </div>;
}

function EvidenceButton({ label, evidence, open }: { label: string; evidence: ContextEvidenceRef[]; open: (title: string, items: ContextEvidenceRef[]) => void }) {
  return <Button aria-label={`${label}，共 ${evidence.length} 条`} variant="outline" size="sm" onClick={() => open(label, evidence)}>Evidence {evidence.length}</Button>;
}

function useEvidenceDrawer(api: ContextCenterApiPort) {
  const [drawerState, setDrawerState] = useState<{ title: string; items: ContextEvidenceRef[] } | null>(null);
  return {
    openEvidence: (title: string, items: ContextEvidenceRef[]) => setDrawerState({ title, items }),
    drawer: <EvidenceReferenceDrawer api={api} title={drawerState?.title || null} items={drawerState?.items || []} onClose={() => setDrawerState(null)} />,
  };
}

export function ContextTimelinePanel({ api }: { api: ContextCenterApiPort }) {
  const [filter, setFilter] = useState("");
  const [appliedFilter, setAppliedFilter] = useState("");
  const [page, setPage] = useState<ContextPage<ContextTimelineItem> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [moreLoading, setMoreLoading] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const request = useRef(0);
  const { openEvidence, drawer } = useEvidenceDrawer(api);
  const load = useCallback(async (cursor?: string) => {
    const requestId = ++request.current;
    if (cursor) {
      setLoading(false);
      setMoreLoading(true);
      setMoreError(null);
    } else {
      setMoreLoading(false);
      setLoading(true);
      setError(null);
      setMoreError(null);
    }
    try {
      const next = await api.listTimeline({ filter: appliedFilter || undefined, cursor });
      if (request.current === requestId) setPage(current => cursor && current ? appendPage(current, next) : next);
    } catch (cause) {
      if (request.current === requestId) (cursor ? setMoreError : setError)(errorMessage(cause));
    } finally {
      if (request.current === requestId) (cursor ? setMoreLoading : setLoading)(false);
    }
  }, [api, appliedFilter]);
  useEffect(() => {
    setPage(null);
    void load();
    return () => { request.current += 1; };
  }, [load]);

  return <div className="space-y-4">
    <div className="flex flex-wrap gap-2">
      <Input aria-label="Timeline 筛选" className="max-w-sm" value={filter} onChange={event => setFilter(event.target.value)} placeholder="按类型、标签或摘要筛选" />
      <Button variant="outline" onClick={() => setAppliedFilter(filter.trim())}>筛选</Button>
      <Button variant="ghost" onClick={() => void load()}><RefreshCw className="mr-1.5 size-4" />刷新</Button>
    </div>
    <Degraded show={Boolean(page?.degraded)} exhausted={Boolean(page?.degraded && !page.nextCursor)} />
    <StateFrame loading={loading && !page} error={error} empty={Boolean(page && page.items.length === 0)} onRetry={() => void load()}>
      <div className="space-y-3" aria-label="Context Timeline">
        {page?.items.map(item => <Card key={item.id} density="compact"><CardContent className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{item.type}</Badge><strong>{item.label}</strong></div><p className="mt-2 text-sm text-muted-foreground">{item.summary || "未提供摘要"}</p></div>
            <EvidenceButton label={`${item.label} 的 Evidence`} evidence={item.evidence} open={openEvidence} />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">{item.authority.label} · {item.entityLabel || "未关联实体"} · {formatDateTime(item.occurredAt)}</p>
        </CardContent></Card>)}
      </div>
      <LoadMore cursor={page?.nextCursor} busy={moreLoading} error={moreError} onLoad={cursor => void load(cursor)} />
    </StateFrame>
    {drawer}
  </div>;
}

function EntityProfileView({ profile, openEvidence }: { profile: ContextEntityProfile | null; openEvidence: (title: string, items: ContextEvidenceRef[]) => void }) {
  if (!profile) return <div className="py-10 text-center text-sm text-muted-foreground"><Loader2 className="mx-auto mb-2 size-4 animate-spin" />正在加载画像</div>;
  return <div className="space-y-4">
    <Degraded show={profile.degraded} />
    <p className="text-xs text-muted-foreground">画像按五类 facet 展示；空分面会明确保留。</p>
    {FACETS.map(facet => {
      const attributes = profile.attributes.filter(attribute => attribute.type === facet.type);
      return <section key={facet.type} aria-label={facet.label} className="rounded-xl border p-4">
        <h3 className="font-medium">{facet.label}</h3>
        {attributes.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">暂无该分面信息</p> : <div className="mt-3 space-y-3">{attributes.map(attribute => <div key={attribute.id} className="rounded-lg border p-3">
          <div className="flex flex-wrap items-center gap-2"><strong className="text-sm">{attribute.label}</strong>{attribute.review && <Badge variant={attribute.review === "conflicted" ? "danger" : "warning"}>{attribute.review}</Badge>}</div>
          <p className="mt-2 text-sm">{attribute.summary || "未提供摘要"}</p>
          {attribute.conflict && <p className="mt-2 text-xs text-danger-ink">冲突：{attribute.conflict}</p>}
          <div className="mt-3 flex items-center justify-between gap-2 text-xs text-muted-foreground"><span>{attribute.authority.label} · v{attribute.revision} · {formatDateTime(attribute.updatedAt)}</span><EvidenceButton label={`${attribute.label} 的 Evidence`} evidence={attribute.evidence} open={openEvidence} /></div>
        </div>)}</div>}
      </section>;
    })}
  </div>;
}

function uniqueEvidence(items: ContextEvidenceRef[]): ContextEvidenceRef[] {
  return [...new Map(items.map(item => [item.id, item])).values()];
}

function CorrectionView({ api, detail, onUpdated, openEvidence }: { api: ContextCenterApiPort; detail: ContextEntityDetail; onUpdated: () => Promise<void>; openEvidence: (title: string, items: ContextEvidenceRef[]) => void }) {
  const [action, setAction] = useState<"assert" | "reject">("assert");
  const [scope, setScope] = useState<"personal" | "organization">("organization");
  const [targetItemId, setTargetItemId] = useState("");
  const [summary, setSummary] = useState("");
  const [evidenceIds, setEvidenceIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = detail.items.find(item => item.id === targetItemId) || null;
  const selectableEvidence = useMemo(() => uniqueEvidence(target?.evidence || []), [target]);
  const expectedRevision = detail.correctionRevisions[scope];
  const conflict = Boolean(error && (error.includes("版本") || error.includes("刷新")));

  const selectTarget = (itemId: string) => {
    const item = detail.items.find(candidate => candidate.id === itemId);
    const nextId = item?.correctable ? itemId : "";
    setTargetItemId(nextId);
    setEvidenceIds(item?.correctable ? item.evidence.map(evidence => evidence.id) : []);
    setError(null);
  };

  const submit = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const common = { scope, targetItemId: target.id, evidenceIds, expectedRevision };
      if (action === "assert") await api.createCorrection(detail.id, { action, ...common, summary: summary.trim() });
      else await api.createCorrection(detail.id, { action, ...common, ...(summary.trim() ? { summary: summary.trim() } : {}) });
      setSummary("");
      setTargetItemId("");
      setEvidenceIds([]);
      await onUpdated();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = Boolean(target?.correctable && evidenceIds.length > 0 && (action === "reject" || summary.trim()));
  return <div className="space-y-4">
    <div className="rounded-xl border p-4">
      <h3 className="font-medium">提交属性纠正</h3>
      <p className="mt-1 text-xs text-muted-foreground">选择一个具体画像项作为目标，按当前范围使用纠正基线 v{expectedRevision} 提交。</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-sm">目标画像项<select aria-label="纠正目标" className="mt-1 w-full rounded-md border bg-background px-3 py-2" value={targetItemId} onChange={event => selectTarget(event.target.value)}><option value="">请选择具体目标</option>{detail.items.map(item => <option key={item.id} value={item.id} disabled={!item.correctable}>{item.type} · {item.label}：{item.summary || "未提供摘要"}{item.correctable ? "" : item.correctionDisabledReason === "conflicted" ? "（冲突待审核，不可纠正）" : "（建议值待审核，不可纠正）"}</option>)}</select><span className="mt-1 block text-xs text-muted-foreground">仅已确认且当前有效的画像项可作为纠正目标；待审核与冲突项仍展示但不可选择。</span></label>
        <label className="text-sm">动作<select aria-label="纠正动作" className="mt-1 w-full rounded-md border bg-background px-3 py-2" value={action} onChange={event => { setAction(event.target.value as typeof action); setError(null); }}><option value="assert">assert · 为该项主张新值</option><option value="reject">reject · 拒绝该项当前值</option></select></label>
        <label className="text-sm">范围<select aria-label="纠正范围" className="mt-1 w-full rounded-md border bg-background px-3 py-2" value={scope} onChange={event => setScope(event.target.value as typeof scope)}><option value="personal">个人</option><option value="organization">组织</option></select></label>
      </div>
      <Textarea aria-label={action === "assert" ? "主张的新值" : "拒绝说明（可选）"} className="mt-3" value={summary} onChange={event => setSummary(event.target.value)} placeholder={action === "assert" ? "填写该画像项应采用的新值（必填）" : "可选：说明为何拒绝该画像项的当前值"} />
      <fieldset className="mt-3" disabled={!target}>
        <legend className="text-sm font-medium">选择 Evidence</legend>
        {!target ? <p className="mt-1 text-xs text-muted-foreground">请先选择目标画像项</p> : selectableEvidence.length === 0 ? <p className="mt-1 text-xs text-muted-foreground">该目标没有可用 Evidence</p> : <div className="mt-2 space-y-2">{selectableEvidence.map(item => <label key={item.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={evidenceIds.includes(item.id)} onChange={event => setEvidenceIds(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))} /><span>{item.label}</span><Button type="button" variant="ghost" size="sm" onClick={() => openEvidence(`${item.label} 的 Evidence`, [item])}>查看</Button></label>)}</div>}
      </fieldset>
      {error && <div role="alert" className="mt-3 flex flex-wrap items-center gap-2 text-sm text-danger-ink"><span>{error}</span>{conflict && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void onUpdated().then(() => setError(null))}><RefreshCw className="mr-1.5 size-3.5" />刷新实体详情</Button>}</div>}
      <Button className="mt-3" disabled={busy || !canSubmit} onClick={() => void submit()}>{busy ? "提交中" : action === "assert" ? "提交新值主张" : "拒绝该项当前值"}</Button>
    </div>
    <div><h3 className="mb-2 font-medium">纠正记录</h3>{detail.corrections.length === 0 ? <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">暂无纠正记录</p> : detail.corrections.map(record => <div key={record.id} className="mb-2 rounded-lg border p-3"><div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{record.action}</Badge><span className="font-medium">{record.label}</span><span className="text-xs text-muted-foreground">{record.authority.label} · v{record.revision}</span></div><p className="mt-2 text-sm">{record.summary}</p><div className="mt-3"><EvidenceButton label={`${record.label} 纠正记录 Evidence`} evidence={record.evidence} open={openEvidence} /></div></div>)}</div>
  </div>;
}

function EntityDetailView({ api, entityId, onBack }: { api: ContextCenterApiPort; entityId: string; onBack: () => void }) {
  const [detail, setDetail] = useState<ContextEntityDetail | null>(null);
  const [profile, setProfile] = useState<ContextEntityProfile | null>(null);
  const [itemPage, setItemPage] = useState<ContextPage<ContextDerivedItem> | null>(null);
  const [correctionPage, setCorrectionPage] = useState<ContextPage<ContextCorrectionRecord> | null>(null);
  const [itemsMoreLoading, setItemsMoreLoading] = useState(false);
  const [itemsMoreError, setItemsMoreError] = useState<string | null>(null);
  const [correctionsMoreLoading, setCorrectionsMoreLoading] = useState(false);
  const [correctionsMoreError, setCorrectionsMoreError] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<ContextPage<ContextTimelineItem> | null>(null);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [timelineMoreLoading, setTimelineMoreLoading] = useState(false);
  const [timelineMoreError, setTimelineMoreError] = useState<string | null>(null);
  const timelineRequest = useRef(0);
  const [relations, setRelations] = useState<ContextPage<ContextRelation> | null>(null);
  const [relationDepth, setRelationDepth] = useState<1 | 2>(1);
  const [relationsLoading, setRelationsLoading] = useState(false);
  const [relationsError, setRelationsError] = useState<string | null>(null);
  const [relationsMoreLoading, setRelationsMoreLoading] = useState(false);
  const [relationsMoreError, setRelationsMoreError] = useState<string | null>(null);
  const relationsRequest = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const { openEvidence, drawer } = useEvidenceDrawer(api);
  const load = useCallback(async () => {
    setError(null);
    try {
      const [nextDetail, nextProfile, nextItems, nextCorrections] = await Promise.all([
        api.getEntity(entityId), api.getEntityProfile(entityId),
        api.listEntityItems(entityId), api.listEntityCorrections(entityId),
      ]);
      setDetail(nextDetail);
      setProfile(nextProfile);
      setItemPage(nextItems);
      setCorrectionPage(nextCorrections);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [api, entityId]);
  useEffect(() => {
    setDetail(null);
    setProfile(null);
    setItemPage(null);
    setCorrectionPage(null);
    setItemsMoreError(null);
    setCorrectionsMoreError(null);
    setTimeline(null);
    setTimelineError(null);
    setTimelineMoreError(null);
    setRelations(null);
    setRelationDepth(1);
    setRelationsError(null);
    setRelationsMoreError(null);
    timelineRequest.current += 1;
    relationsRequest.current += 1;
    void load();
  }, [entityId, load]);
  const loadMoreItems = async (cursor: string) => {
    setItemsMoreLoading(true);
    setItemsMoreError(null);
    try {
      const next = await api.listEntityItems(entityId, { cursor });
      setItemPage(current => current ? appendPage(current, next) : next);
    } catch (cause) {
      setItemsMoreError(errorMessage(cause));
    } finally {
      setItemsMoreLoading(false);
    }
  };
  const loadMoreCorrections = async (cursor: string) => {
    setCorrectionsMoreLoading(true);
    setCorrectionsMoreError(null);
    try {
      const next = await api.listEntityCorrections(entityId, { cursor });
      setCorrectionPage(current => current ? appendPage(current, next) : next);
    } catch (cause) {
      setCorrectionsMoreError(errorMessage(cause));
    } finally {
      setCorrectionsMoreLoading(false);
    }
  };
  const loadTimeline = async (cursor?: string) => {
    const requestId = ++timelineRequest.current;
    if (cursor) {
      setTimelineLoading(false);
      setTimelineMoreLoading(true);
      setTimelineMoreError(null);
    } else {
      setTimelineMoreLoading(false);
      setTimeline(null);
      setTimelineLoading(true);
      setTimelineError(null);
      setTimelineMoreError(null);
    }
    try {
      const next = await api.listTimeline({ entityId, ...(cursor ? { cursor } : {}) });
      if (timelineRequest.current === requestId) setTimeline(current => cursor && current ? appendPage(current, next) : next);
    } catch (cause) {
      if (timelineRequest.current === requestId) (cursor ? setTimelineMoreError : setTimelineError)(errorMessage(cause));
    } finally {
      if (timelineRequest.current === requestId) (cursor ? setTimelineMoreLoading : setTimelineLoading)(false);
    }
  };
  const loadRelations = async (depth: 1 | 2 = relationDepth, cursor?: string) => {
    const requestId = ++relationsRequest.current;
    if (cursor) {
      setRelationsLoading(false);
      setRelationsMoreLoading(true);
      setRelationsMoreError(null);
    } else {
      setRelationsMoreLoading(false);
      setRelations(null);
      setRelationsLoading(true);
      setRelationsError(null);
      setRelationsMoreError(null);
    }
    try {
      const next = await api.listEntityRelations(entityId, { depth, ...(cursor ? { cursor } : {}) });
      if (relationsRequest.current === requestId) setRelations(current => cursor && current ? appendPage(current, next) : next);
    } catch (cause) {
      if (relationsRequest.current === requestId) (cursor ? setRelationsMoreError : setRelationsError)(errorMessage(cause));
    } finally {
      if (relationsRequest.current === requestId) (cursor ? setRelationsMoreLoading : setRelationsLoading)(false);
    }
  };

  const pagedDetail = detail ? {
    ...detail,
    items: itemPage?.items ?? detail.items,
    corrections: correctionPage?.items ?? detail.corrections,
    degraded: detail.degraded || Boolean(itemPage?.degraded) || Boolean(correctionPage?.degraded),
  } : null;

  return <div>
    <Button variant="ghost" className="mb-3" onClick={onBack}><ArrowLeft className="mr-1.5 size-4" />返回实体列表</Button>
    {error && !detail ? <StateFrame loading={false} error={error} empty={false} onRetry={() => void load()}>{null}</StateFrame> : !detail ? <StateFrame loading error={null} empty={false} onRetry={() => void load()}>{null}</StateFrame> : <>
      <div className="mb-4"><div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{detail.type}</Badge><h2 className="text-xl font-semibold">{detail.label}</h2><Badge variant="muted">v{detail.revision}</Badge></div><p className="mt-2 text-sm text-muted-foreground">{detail.summary || "未提供摘要"} · 更新于 {formatDateTime(detail.updatedAt)}</p></div>
      <Degraded show={detail.degraded} />
      {error && <p role="alert" className="mb-3 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger-ink">{error}</p>}
      <Tabs defaultValue="profile" onValueChange={value => { if (value === "timeline" && !timeline) void loadTimeline(); if (value === "relations" && !relations) void loadRelations(); }}>
        <div className="overflow-x-auto"><TabsList aria-label="实体详情区域" className="min-w-max"><TabsTrigger value="profile">画像</TabsTrigger><TabsTrigger value="timeline">Timeline</TabsTrigger><TabsTrigger value="relations">关系</TabsTrigger><TabsTrigger value="corrections">纠正记录</TabsTrigger></TabsList></div>
        <TabsContent value="profile" className="mt-4"><EntityProfileView profile={profile} openEvidence={openEvidence} /></TabsContent>
        <TabsContent value="timeline" className="mt-4">
          <Degraded show={Boolean(timeline?.degraded)} exhausted={Boolean(timeline?.degraded && !timeline.nextCursor)} />
          <StateFrame loading={timelineLoading && !timeline} error={timelineError} empty={Boolean(timeline && timeline.items.length === 0)} onRetry={() => void loadTimeline()}>
            <div className="space-y-2">{timeline?.items.map(item => <div key={item.id} className="rounded-lg border p-3"><div className="flex justify-between gap-2"><div><strong className="text-sm">{item.label}</strong><p className="mt-1 text-sm text-muted-foreground">{item.summary}</p></div><EvidenceButton label={`${item.label} 的 Evidence`} evidence={item.evidence} open={openEvidence} /></div></div>)}</div>
            <LoadMore cursor={timeline?.nextCursor} busy={timelineMoreLoading} error={timelineMoreError} onLoad={cursor => void loadTimeline(cursor)} />
          </StateFrame>
        </TabsContent>
        <TabsContent value="relations" className="mt-4">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <p className="max-w-2xl text-xs text-muted-foreground">
              一跳展示中心实体到目标实体；二跳展示上一跳到目标实体的有限授权路径，不是完整图谱。
            </p>
            <label className="text-sm">关系深度
              <select
                aria-label="关系深度"
                className="ml-2 rounded-md border bg-background px-3 py-2"
                value={relationDepth}
                onChange={event => {
                  const depth = Number(event.target.value) as 1 | 2;
                  setRelationDepth(depth);
                  void loadRelations(depth);
                }}
              >
                <option value={1}>一跳</option>
                <option value={2}>二跳（有限授权路径）</option>
              </select>
            </label>
          </div>
          <Degraded show={Boolean(relations?.degraded)} exhausted={Boolean(relations?.degraded && !relations.nextCursor)} />
          <StateFrame loading={relationsLoading && !relations} error={relationsError} empty={Boolean(relations && relations.items.length === 0)} onRetry={() => void loadRelations(relationDepth)}>
            <ul className="overflow-hidden rounded-lg border" aria-label="中心实体邻接关系">
              {relations?.items.map(relation => (
                <li key={relation.id} className="grid grid-cols-1 gap-3 border-b p-3 last:border-b-0 md:grid-cols-3 md:items-center">
                  <div className="text-sm"><span className="text-xs text-muted-foreground">{relation.depth === 1 ? "中心" : "上一跳"}</span> <strong>{relation.fromEntity.label}</strong> <span aria-hidden="true">→</span> <strong>{relation.targetEntity.label}</strong><span className="ml-2 text-xs text-muted-foreground">{relation.targetEntity.type}</span></div>
                  <div className="text-sm">{relation.label}</div>
                  <div className="flex flex-wrap items-center gap-2 md:justify-end">
                    <Badge variant="outline">depth {relation.depth} · {relation.depth === 1 ? "一跳" : "二跳"}</Badge>
                    <Badge variant={relation.level === "inferred" ? "warning" : "outline"}>{RELATION_LABEL[relation.level]}</Badge>
                    <Badge variant={relation.reviewStatus === "rejected" ? "danger" : relation.reviewStatus === "proposed" ? "warning" : "success"}>{RELATION_REVIEW_LABEL[relation.reviewStatus]}</Badge>
                    <EvidenceButton label={`${relation.label} 的 Evidence`} evidence={relation.evidence} open={openEvidence} />
                  </div>
                </li>
              ))}
            </ul>
            <LoadMore cursor={relations?.nextCursor} busy={relationsMoreLoading} error={relationsMoreError} onLoad={cursor => void loadRelations(relationDepth, cursor)} />
          </StateFrame>
        </TabsContent>
        <TabsContent value="corrections" className="mt-4">
          <Degraded show={Boolean(pagedDetail?.degraded)} exhausted={Boolean(pagedDetail?.degraded && !itemPage?.nextCursor && !correctionPage?.nextCursor)} />
          {pagedDetail && <CorrectionView api={api} detail={pagedDetail} onUpdated={load} openEvidence={openEvidence} />}
          <LoadMore label="加载更多可纠正画像项" cursor={itemPage?.nextCursor} busy={itemsMoreLoading} error={itemsMoreError} onLoad={cursor => void loadMoreItems(cursor)} />
          <LoadMore label="加载更多纠正记录" cursor={correctionPage?.nextCursor} busy={correctionsMoreLoading} error={correctionsMoreError} onLoad={cursor => void loadMoreCorrections(cursor)} />
        </TabsContent>
      </Tabs>
    </>}
    {drawer}
  </div>;
}

export function ContextEntitiesPanel({ api }: { api: ContextCenterApiPort }) {
  const [filter, setFilter] = useState("");
  const [applied, setApplied] = useState("");
  const [page, setPage] = useState<ContextPage<ContextEntity> | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [moreLoading, setMoreLoading] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const request = useRef(0);
  const load = useCallback(async (cursor?: string) => {
    const requestId = ++request.current;
    if (cursor) {
      setLoading(false);
      setMoreLoading(true);
      setMoreError(null);
    } else {
      setMoreLoading(false);
      setLoading(true);
      setError(null);
      setMoreError(null);
    }
    try {
      const next = await api.listEntities({ filter: applied || undefined, ...(cursor ? { cursor } : {}) });
      if (request.current === requestId) setPage(current => cursor && current ? appendPage(current, next) : next);
    } catch (cause) {
      if (request.current === requestId) (cursor ? setMoreError : setError)(errorMessage(cause));
    } finally {
      if (request.current === requestId) (cursor ? setMoreLoading : setLoading)(false);
    }
  }, [api, applied]);
  useEffect(() => {
    setPage(null);
    void load();
    return () => { request.current += 1; };
  }, [load]);
  if (selected) return <EntityDetailView api={api} entityId={selected} onBack={() => setSelected(null)} />;
  return <div className="space-y-4">
    <div className="flex gap-2"><Input aria-label="实体筛选" className="max-w-sm" value={filter} onChange={event => setFilter(event.target.value)} placeholder="按类型、标签或摘要筛选" /><Button variant="outline" onClick={() => { const next = filter.trim(); if (next === applied) void load(); else setApplied(next); }}>筛选</Button></div>
    <Degraded show={Boolean(page?.degraded)} exhausted={Boolean(page?.degraded && !page.nextCursor)} />
    <StateFrame loading={loading && !page} error={error} empty={Boolean(page && page.items.length === 0)} onRetry={() => void load()}>
      <div className="grid gap-3 md:grid-cols-2">{page?.items.map(entity => <button key={entity.id} type="button" className="rounded-xl border bg-card p-4 text-left transition-colors hover:border-primary/40" onClick={() => setSelected(entity.id)}><div className="flex items-center gap-2"><Badge variant="outline">{entity.type}</Badge><strong>{entity.label}</strong><span className="ml-auto text-xs text-muted-foreground">v{entity.revision}</span></div><p className="mt-2 text-sm text-muted-foreground">{entity.summary || "未提供摘要"}</p><p className="mt-3 text-xs text-muted-foreground">更新于 {formatDateTime(entity.updatedAt)}</p></button>)}</div>
      <LoadMore cursor={page?.nextCursor} busy={moreLoading} error={moreError} onLoad={cursor => void load(cursor)} />
    </StateFrame>
  </div>;
}

export function ContextReviewsPanel({ api }: { api: ContextCenterApiPort }) {
  const [page, setPage] = useState<ContextPage<ContextReviewItem> | null>(null);
  const [status, setStatus] = useState<"" | "proposed" | "conflicted">("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [moreLoading, setMoreLoading] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const request = useRef(0);
  const { openEvidence, drawer } = useEvidenceDrawer(api);
  const load = useCallback(async (cursor?: string) => {
    const requestId = ++request.current;
    if (cursor) {
      setLoading(false);
      setMoreLoading(true);
      setMoreError(null);
    } else {
      setMoreLoading(false);
      setLoading(true);
      setError(null);
      setMoreError(null);
    }
    try {
      const next = await api.listReviews({ filter: status || undefined, ...(cursor ? { cursor } : {}) });
      if (request.current === requestId) setPage(current => cursor && current ? appendPage(current, next) : next);
    } catch (cause) {
      if (request.current === requestId) (cursor ? setMoreError : setError)(errorMessage(cause));
    } finally {
      if (request.current === requestId) (cursor ? setMoreLoading : setLoading)(false);
    }
  }, [api, status]);
  useEffect(() => {
    setPage(null);
    setActionError(null);
    void load();
    return () => { request.current += 1; };
  }, [load]);
  const decide = async (item: ContextReviewItem, decision: "confirm" | "reject") => {
    setBusy(item.id);
    setActionError(null);
    try {
      await api.decideReview(item.id, { decision, expectedRevision: item.revision });
      await load();
    } catch (cause) {
      setActionError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };
  const queue = page?.items.filter(item => item.status === "proposed" || item.status === "conflicted") || [];
  return <div className="space-y-4">
    <label className="block max-w-xs text-sm">审核状态<select aria-label="审核状态筛选" className="mt-1 w-full rounded-md border bg-background px-3 py-2" value={status} onChange={event => setStatus(event.target.value as typeof status)}><option value="">全部待审核</option><option value="proposed">proposed</option><option value="conflicted">conflicted</option></select></label>
    <Degraded show={Boolean(page?.degraded)} exhausted={Boolean(page?.degraded && !page.nextCursor)} />
    {actionError && <p role="alert" className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger-ink">审核操作失败：{actionError}</p>}
    <StateFrame loading={loading && !page} error={error} empty={Boolean(page && queue.length === 0)} onRetry={() => void load()}>
      <div className="space-y-3">{queue.map(item => <Card key={item.id} density="compact"><CardHeader><CardTitle className="flex flex-wrap items-center gap-2"><Badge variant={item.status === "conflicted" ? "danger" : "warning"}>{item.status}</Badge>{item.entityLabel} · {item.label}<span className="ml-auto text-xs font-normal text-muted-foreground">v{item.revision}</span></CardTitle></CardHeader><CardContent><div className="grid gap-3 sm:grid-cols-2"><div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">原值</p><p className="mt-1 text-sm">{item.originalSummary || "无原值"}</p></div><div className="rounded-lg border border-primary/30 bg-primary/5 p-3"><p className="text-xs text-muted-foreground">建议值</p><p className="mt-1 text-sm">{item.proposedSummary}</p></div></div>{item.conflict && <p className="mt-3 text-sm text-danger-ink">冲突：{item.conflict}</p>}<div className="mt-4 flex flex-wrap items-center gap-2"><EvidenceButton label={`${item.label} 审核 Evidence`} evidence={item.evidence} open={openEvidence} /><span className="mr-auto text-xs text-muted-foreground">{item.authority.label} · {formatDateTime(item.updatedAt)}</span><Button variant="outline" disabled={busy === item.id} onClick={() => void decide(item, "reject")}>拒绝建议值</Button><Button disabled={busy === item.id} onClick={() => void decide(item, "confirm")}>确认建议值</Button></div></CardContent></Card>)}</div>
      <LoadMore cursor={page?.nextCursor} busy={moreLoading} error={moreError} onLoad={cursor => void load(cursor)} />
    </StateFrame>
    {drawer}
  </div>;
}
