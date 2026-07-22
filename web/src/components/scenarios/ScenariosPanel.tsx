import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import {
  buildScenarioPrompt,
  resolveScenarioSlug,
  type CatalogScenarioPublic,
  type IndustryType,
  type ScenarioItem,
  type ScenarioLibraryResponse,
  type WorkflowLibraryPublicV3,
} from "@agent/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CapabilityFilterTabs } from "@/components/CapabilityCenter/CatalogUi";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/contexts/AuthContext";
import {
  ScenarioCard,
  ScenarioModeBadge,
  ScenarioRequireBadges,
  WorkflowPresentationCard,
  WorkflowScenarioCard,
} from "./ScenarioCard";
import { ScenarioDetailDialog } from "./ScenarioDetailDialog";
import { WorkflowPresentationDialog } from "./WorkflowPresentationDialog";
import { matchRoleIdByPosition, useScenarioLibrary } from "./useScenarioLibrary";
import { RoleKitDetailPage } from "./RoleKitDetailPage";
import { INDUSTRY_ALL, matchIndustry, type IndustryFilterValue } from "./useIndustryFilter";
import { useScenarioFilters } from "./useScenarioFilters";
import { friendlyIndustry } from "./friendlyMappings";
import {
  filterWorkflowScenarios,
  BUSINESS_MODEL_ALL,
  MATURITY_ALL,
  OUTCOME_ALL,
  OUTCOME_OPTIONS,
  ROLE_ALL,
  VERTICAL_ALL,
  type BusinessModelFilterValue,
  type MaturityFilterValue,
  type OutcomeFilterValue,
  type VerticalFilterValue,
  type WorkflowPrimaryAction,
  workflowOperationalCta,
} from "./workflowUi";

const INDUSTRY_ORDER: IndustryType[] = [
  "manufacturing", "trade", "retail", "service", "export", "ecommerce",
];
const INDUSTRY_CHIPS = INDUSTRY_ORDER.map((id) => ({ value: id, label: friendlyIndustry[id] }));

export interface ScenariosPanelProps {
  onTryScenario: (prompt: string, scenario: ScenarioItem) => void;
  onStartWorkflow?: (
    starterMessage: string,
    scenario: CatalogScenarioPublic,
    options?: { isolatedDemo?: boolean },
  ) => void;
  onConnectWorkflow?: (workflowId: string) => void;
  onRequestDiagnosis?: (message: string, scenario: CatalogScenarioPublic) => void;
  onWorkflowSelected?: (scenario: CatalogScenarioPublic) => void;
  roleDetailId?: string | null;
  onOpenRoleDetail?: (roleId: string) => void;
  onCloseRoleDetail?: () => void;
}

export function ScenariosPanel(props: ScenariosPanelProps) {
  const result = useScenarioLibrary();
  const { user } = useAuth();
  const filters = useScenarioFilters();
  const [detail, setDetail] = useState<{
    scenario: CatalogScenarioPublic;
    skinId?: string;
    roleViewId?: string;
    roleId?: string;
  } | null>(null);
  const [presentation, setPresentation] = useState<CatalogScenarioPublic | null>(null);
  const [catalogExpanded, setCatalogExpanded] = useState(false);
  const [deferredNotice, setDeferredNotice] = useState<WorkflowLibraryPublicV3["deferredObjects"][number] | null>(null);
  const deepLinkConsumed = useRef(false);
  const userSelectedRole = useRef(false);

  const workflowLibrary = result.workflowLibrary ?? null;
  const roles = workflowLibrary?.roles ?? result.library?.roles ?? [];

  useEffect(() => {
    if (userSelectedRole.current || filters.activeRole !== ROLE_ALL) return;
    const requested = props.roleDetailId
      ?? user?.preferences?.activeRoleId
      ?? matchRoleIdByPosition(roles, user?.position);
    if (requested && roles.some((role) => role.id === requested)) filters.setActiveRole(requested);
  }, [filters.activeRole, filters.setActiveRole, props.roleDetailId, roles, user?.position, user?.preferences?.activeRoleId]);

  const handleWorkflowAction = (action: WorkflowPrimaryAction, scenario: CatalogScenarioPublic) => {
    props.onWorkflowSelected?.(scenario);
    if (action === "presentation") {
      if (scenario.presentation) setPresentation(scenario);
      else setDetail({ scenario });
      return;
    }
    if (action === "chat") {
      if (props.onStartWorkflow) props.onStartWorkflow(scenario.launch.starterMessage, scenario);
      else setDetail({ scenario });
      return;
    }
    if (action === "replay") {
      if (scenario.demo.sharePath) window.location.assign(scenario.demo.sharePath);
      else setDetail({ scenario });
      return;
    }
    if (action === "isolated-demo") {
      if (props.onStartWorkflow) {
        setDetail(null);
        props.onStartWorkflow(
          scenario.launch.starterMessage,
          scenario,
          { isolatedDemo: true },
        );
      } else setDetail({ scenario });
      return;
    }
    if (action === "connector") {
      if (props.onConnectWorkflow) props.onConnectWorkflow(scenario.workflowId);
      else setDetail({ scenario });
      return;
    }
    if (action === "diagnosis") {
      if (props.onRequestDiagnosis) {
        props.onRequestDiagnosis(`我想为「${scenario.title}」预约落地诊断，请先确认业务边界、现有系统和所需人审。`, scenario);
      } else setDetail({ scenario });
      return;
    }
    setDetail({ scenario });
  };

  useEffect(() => {
    if (!workflowLibrary || deepLinkConsumed.current) return;
    const params = new URLSearchParams(window.location.search);
    const slug = params.get("workflow") ?? params.get("scenario");
    if (!slug) return;
    deepLinkConsumed.current = true;
    const resolved = resolveScenarioSlug(workflowLibrary, slug);
    if (!resolved) return;
    if (resolved.resolution === "deferred") {
      setDeferredNotice(resolved.deferredObject);
      if (resolved.roleId) filters.setActiveRole(resolved.roleId);
      params.delete("scenario");
      params.set("workflow", resolved.resolvedFromLegacySlug);
      params.set("intent", "view");
      window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
      return;
    }
    const skinId = params.get("skinId") ?? resolved.skinId;
    const roleViewId = params.get("roleViewId") ?? resolved.roleViewId;
    const roleId = params.get("roleId") ?? resolved.roleId;
    props.onWorkflowSelected?.(resolved.scenario);
    setDetail({
      scenario: resolved.scenario,
      ...(skinId ? { skinId } : {}),
      ...(roleViewId ? { roleViewId } : {}),
      ...(roleId ? { roleId } : {}),
    });
    if (roleId) filters.setActiveRole(roleId);
    const intent = params.get("intent");
    params.delete("scenario");
    params.set("workflow", resolved.scenario.id);
    if (skinId) params.set("skinId", skinId);
    if (roleViewId) params.set("roleViewId", roleViewId);
    if (roleId) params.set("roleId", roleId);
    if (intent === "run" || intent === "connect") params.set("intent", "view");
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
    if (intent === "run" && resolved.scenario.launch.startMode === "chat") {
      handleWorkflowAction("chat", resolved.scenario);
    } else if (intent === "connect" && resolved.scenario.launch.startMode === "connector") {
      handleWorkflowAction("connector", resolved.scenario);
    }
  // handleWorkflowAction 只消费当前 props；deep link 明确只运行一次。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowLibrary]);

  if (result.loading) {
    return <div className="flex h-full items-center justify-center gap-2 text-muted-foreground"><Loader2 className="size-4 animate-spin" /><span className="text-sm">加载 AI 同事工作流...</span></div>;
  }
  if (result.error || (!workflowLibrary && !result.library)) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <span className="text-sm">{result.error || "AI 同事工作流暂时不可用"}</span>
        <Button type="button" variant="outline" size="sm" onClick={result.reload}>重试</Button>
      </div>
    );
  }

  if (!workflowLibrary && result.library) {
    return (
      <LegacyScenariosPanel
        {...props}
        library={result.library}
        fallbackReason={result.fallbackReason}
        industry={filters.activeIndustry}
        setIndustry={filters.setActiveIndustry}
      />
    );
  }
  if (!workflowLibrary) return null;

  const scenarios = filterWorkflowScenarios(workflowLibrary.scenarios, {
    outcome: filters.activeOutcome,
    role: filters.activeRole,
    industry: filters.activeIndustry,
    vertical: filters.activeVertical,
    businessModel: filters.activeBusinessModel,
    maturity: filters.activeMaturity,
  });
  const verticalOptions = sortedUnique(workflowLibrary.skins.flatMap((skin) => skin.industryVerticals));
  const businessModelOptions = sortedUnique(workflowLibrary.skins.flatMap((skin) => skin.businessModels));
  const maturityOptions = ["Excel/钉钉为主", "已有单体系统", "多系统已集成"] as const;
  const roleDetailName = props.roleDetailId
    ? workflowLibrary.roles.find((role) => role.id === props.roleDetailId)?.name
    : null;
  const hasFilters = filters.activeOutcome !== OUTCOME_ALL
    || filters.activeRole !== ROLE_ALL
    || filters.activeIndustry !== INDUSTRY_ALL
    || filters.activeVertical !== VERTICAL_ALL
    || filters.activeBusinessModel !== BUSINESS_MODEL_ALL
    || filters.activeMaturity !== MATURITY_ALL;
  const presentationScenarios = workflowLibrary.scenarios
    .filter((scenario) => scenario.presentation)
    .sort((left, right) => (left.featuredOrder ?? Number.MAX_SAFE_INTEGER) - (right.featuredOrder ?? Number.MAX_SAFE_INTEGER));
  const showFullCatalog = presentationScenarios.length === 0
    || catalogExpanded
    || hasFilters
    || !!roleDetailName;

  return (
    <div className="w-full px-4 pb-4 sm:px-6 sm:pb-6 md:pt-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{roleDetailName ? `${roleDetailName} AI 同事工作流` : "AI 同事能帮你完成什么"}</h1>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            {presentationScenarios.length > 0 && !roleDetailName
              ? "先挑一件真实工作，一步一步看它如何判断、行动并改变业务系统。"
              : `从业务事件到系统终态，不只生成报告。默认目录共 ${workflowLibrary.scenarios.length} 个唯一工作流。`}
          </p>
        </div>
        {roleDetailName && props.onCloseRoleDetail ? <Button variant="outline" size="sm" onClick={props.onCloseRoleDetail}>返回目录</Button> : null}
      </div>

      {presentationScenarios.length > 0 && !roleDetailName ? (
        <section aria-labelledby="guided-presentations-title">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <h2 id="guided-presentations-title" className="font-semibold">推荐先体验</h2>
              <p className="mt-1 text-xs text-muted-foreground">演示数据均为虚构；每一步由你推进，不会修改真实系统。</p>
            </div>
            <Badge variant="secondary">首批 {presentationScenarios.length} 个</Badge>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" data-testid="guided-presentations">
            {presentationScenarios.map((scenario) => (
              <WorkflowPresentationCard key={scenario.id} scenario={scenario} onPrimaryAction={handleWorkflowAction} />
            ))}
          </div>
        </section>
      ) : null}

      {showFullCatalog ? <>
      {presentationScenarios.length > 0 && !roleDetailName ? (
        <div className="mb-5 mt-8 flex items-center gap-3">
          <span className="h-px flex-1 bg-border" />
          <span className="text-xs font-medium text-muted-foreground">全部工作场景</span>
          <span className="h-px flex-1 bg-border" />
        </div>
      ) : null}
      <div className="mb-2 text-xs font-medium text-muted-foreground">我要解决什么</div>
      <CapabilityFilterTabs
        ariaLabel="按业务结果筛选"
        options={[{ value: OUTCOME_ALL, label: "全部结果" }, ...OUTCOME_OPTIONS.map((value) => ({ value, label: value }))]}
        value={filters.activeOutcome}
        onValueChange={(value) => filters.setActiveOutcome(value as OutcomeFilterValue)}
        className="mb-4"
      />
      <div className="mb-2 text-xs font-medium text-muted-foreground">岗位</div>
      <CapabilityFilterTabs
        ariaLabel="按岗位筛选"
        options={[{ value: ROLE_ALL, label: "全部岗位" }, ...workflowLibrary.roles.map((role) => ({ value: role.id, label: role.name }))]}
        value={filters.activeRole}
        onValueChange={(value) => { userSelectedRole.current = true; filters.setActiveRole(value); }}
        className="mb-4"
      />
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-muted-foreground">业务入口</span>
        {hasFilters ? (
          <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={filters.clearFilters}>
            <RotateCcw className="size-3" />清空筛选
          </Button>
        ) : null}
      </div>
      <CapabilityFilterTabs
        ariaLabel="按业务入口筛选"
        options={[{ value: INDUSTRY_ALL, label: "全部行业" }, ...INDUSTRY_CHIPS]}
        value={filters.activeIndustry}
        onValueChange={(value) => filters.setActiveIndustry(value as IndustryFilterValue)}
        className="mb-4"
      />
      <div className="mb-2 text-xs font-medium text-muted-foreground">垂直行业</div>
      <CapabilityFilterTabs
        ariaLabel="按垂直行业筛选"
        options={[{ value: VERTICAL_ALL, label: "全部垂直行业" }, ...verticalOptions.map((value) => ({ value, label: value }))]}
        value={filters.activeVertical}
        onValueChange={(value) => filters.setActiveVertical(value as VerticalFilterValue)}
        className="mb-4"
      />
      <div className="mb-2 text-xs font-medium text-muted-foreground">经营模式</div>
      <CapabilityFilterTabs
        ariaLabel="按经营模式筛选"
        options={[{ value: BUSINESS_MODEL_ALL, label: "全部经营模式" }, ...businessModelOptions.map((value) => ({ value, label: value }))]}
        value={filters.activeBusinessModel}
        onValueChange={(value) => filters.setActiveBusinessModel(value as BusinessModelFilterValue)}
        className="mb-4"
      />
      <div className="mb-2 text-xs font-medium text-muted-foreground">数字化基础</div>
      <CapabilityFilterTabs
        ariaLabel="按数字化基础筛选"
        options={[{ value: MATURITY_ALL, label: "全部数字化基础" }, ...maturityOptions.map((value) => ({ value, label: value }))]}
        value={filters.activeMaturity}
        onValueChange={(value) => filters.setActiveMaturity(value as MaturityFilterValue)}
        className="mb-5"
      />

      {scenarios.length === 0 ? (
        <div className="rounded-xl border border-dashed py-14 text-center text-sm text-muted-foreground">
          当前组合没有匹配的工作流
          <div><Button type="button" variant="link" onClick={filters.clearFilters}>重置全部筛选</Button></div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" data-testid="workflow-catalog">
          {scenarios.map((scenario) => (
            <WorkflowScenarioCard
              key={scenario.id}
              scenario={scenario}
              onOpenDetail={(scenario) => {
                props.onWorkflowSelected?.(scenario);
                setDetail({ scenario });
              }}
              onPrimaryAction={handleWorkflowAction}
            />
          ))}
        </div>
      )}
      </> : (
        <div className="mt-6 flex justify-center">
          <Button type="button" variant="outline" onClick={() => setCatalogExpanded(true)}>
            浏览全部 {workflowLibrary.scenarios.length} 个工作场景
          </Button>
        </div>
      )}

      <ScenarioDetailDialog
        scenario={detail?.scenario ?? null}
        library={workflowLibrary}
        vertical={filters.activeVertical}
        businessModel={filters.activeBusinessModel}
        maturity={filters.activeMaturity}
        skinId={detail?.skinId}
        roleViewId={detail?.roleViewId}
        roleId={detail?.roleId ?? (filters.activeRole === ROLE_ALL ? null : filters.activeRole)}
        open={!!detail}
        onOpenChange={(open) => { if (!open) setDetail(null); }}
        onPrimaryAction={handleWorkflowAction}
      />
      <WorkflowPresentationDialog
        scenario={presentation}
        open={!!presentation}
        onOpenChange={(open) => { if (!open) setPresentation(null); }}
        onUseScenario={(scenario) => {
          setPresentation(null);
          handleWorkflowAction(workflowOperationalCta(scenario).action, scenario);
        }}
      />
      <Dialog open={!!deferredNotice} onOpenChange={(open) => { if (!open) setDeferredNotice(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>当前未作为标准工作流开放</DialogTitle>
            <DialogDescription className="text-left leading-6">
              {deferredNotice?.reason}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">该旧入口不会启动聊天或模拟运行。你可以返回目录选择已经开放的工作流。</p>
          <DialogFooter><Button type="button" onClick={() => setDeferredNotice(null)}>返回工作流目录</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "zh-CN"));
}

function LegacyScenariosPanel({
  library,
  fallbackReason,
  industry,
  setIndustry,
  onTryScenario,
  roleDetailId,
  onOpenRoleDetail,
  onCloseRoleDetail,
}: ScenariosPanelProps & {
  library: ScenarioLibraryResponse;
  fallbackReason: string | null;
  industry: IndustryFilterValue;
  setIndustry: (value: IndustryFilterValue) => void;
}) {
  const { user } = useAuth();
  const [activeRole, setActiveRole] = useState("all");
  const [detail, setDetail] = useState<ScenarioItem | null>(null);
  const userSelectedRole = useRef(false);
  useEffect(() => {
    if (userSelectedRole.current) return;
    const preferred = user?.preferences?.activeRoleId && library.roles.some((role) => role.id === user.preferences?.activeRoleId)
      ? user.preferences.activeRoleId
      : matchRoleIdByPosition(library.roles, user?.position);
    if (preferred) setActiveRole(preferred);
  }, [library.roles, user?.position, user?.preferences?.activeRoleId]);

  const scenarios = useMemo(() => library.scenarios.filter((scenario) => {
    if (!matchIndustry(scenario.industryFocus, industry)) return false;
    return activeRole === "all" || scenario.role === activeRole;
  }), [activeRole, industry, library.scenarios]);
  const roleDetail = library.roles.find((role) => role.id === roleDetailId) ?? null;
  const roleNameById = new Map(library.roles.map((role) => [role.id, role.name]));
  const handleTry = (scenario: ScenarioItem) => {
    setDetail(null);
    onTryScenario(buildScenarioPrompt(scenario), scenario);
  };

  if (roleDetail) {
    return <RoleKitDetailPage role={roleDetail} scenarios={library.scenarios} industryHint={user?.preferences?.industryHint} onTryScenario={handleTry} onBack={onCloseRoleDetail} />;
  }

  return (
    <div className="w-full px-4 pb-4 sm:px-6 sm:pb-6 md:pt-6">
      {fallbackReason ? <div role="status" className="mb-4 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm">当前显示兼容目录。Agent 开小差了，请发送「继续」。</div> : null}
      <div className="mb-4 flex items-start justify-between gap-3">
        <div><h1 className="text-xl font-semibold">任务模板</h1><p className="mt-1 text-sm text-muted-foreground">{fallbackReason ? "兼容目录仍按起手话术运行。" : "按岗位挑一个任务模板，点「试一试」即可预填起手话术，发送前仍可编辑。"}</p></div>
        {activeRole !== "all" && onOpenRoleDetail ? <Button variant="outline" size="sm" onClick={() => onOpenRoleDetail(activeRole)}>查看该岗详情</Button> : null}
      </div>
      <CapabilityFilterTabs ariaLabel="按行业筛选" options={[{ value: INDUSTRY_ALL, label: "全部行业" }, ...INDUSTRY_CHIPS]} value={industry} onValueChange={(value) => setIndustry(value as IndustryFilterValue)} className="mb-3" />
      <CapabilityFilterTabs ariaLabel="按岗位筛选" options={[{ value: "all", label: "全部" }, ...library.roles.map((role) => ({ value: role.id, label: role.name }))]} value={activeRole} onValueChange={(value) => { userSelectedRole.current = true; setActiveRole(value); }} className="mb-5" />
      {scenarios.length === 0 ? (
        <div className="py-16 text-center text-sm text-muted-foreground">{industry !== INDUSTRY_ALL ? `${friendlyIndustry[industry]}行业暂无匹配任务模板，试试切换到「全部行业」` : "该岗位暂无任务模板"}</div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {scenarios.map((scenario) => <ScenarioCard key={scenario.id} scenario={scenario} onTry={handleTry} onOpenDetail={setDetail} />)}
        </div>
      )}
      <Dialog open={!!detail} onOpenChange={(open) => { if (!open) setDetail(null); }}>
        <DialogContent className="max-w-lg">
          {detail ? <><DialogHeader><DialogTitle className="flex items-center gap-2 pr-6"><span>{detail.title}</span><ScenarioModeBadge mode={detail.mode} /></DialogTitle><DialogDescription className="text-left">{detail.pitch}</DialogDescription></DialogHeader><div className="space-y-4 text-sm"><div className="text-xs text-muted-foreground">岗位：{roleNameById.get(detail.role) ?? detail.role}</div><ol className="space-y-2">{detail.story.split("→").map((step, index) => <li key={`${step}-${index}`} className="flex gap-2"><span>{index + 1}.</span><span className="text-muted-foreground">{step.trim()}</span></li>)}</ol>{detail.slots.length > 0 ? <div><div className="mb-2 font-medium">需要你补充的信息</div><ul className="space-y-1.5">{detail.slots.map((slot) => <li key={slot.key} className="text-muted-foreground"><span className="text-foreground">{slot.label}</span><span className="mx-1">·</span>示例：{slot.example}</li>)}</ul></div> : null}<ScenarioRequireBadges requires={detail.requires} /></div><DialogFooter><Button onClick={() => handleTry(detail)}>试一试</Button></DialogFooter></> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
