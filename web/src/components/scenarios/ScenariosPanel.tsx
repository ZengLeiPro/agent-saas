import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { BriefcaseBusiness, ListFilter, Loader2, RotateCcw, SearchX, Target, X } from "lucide-react";
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
import { CapabilityFilterTabs, CatalogHeader, CAPABILITY_EMPTY_SURFACE } from "@/components/CapabilityCenter/CatalogUi";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/contexts/AuthContext";
import { ScenarioCard, ScenarioModeBadge, ScenarioRequireBadges, WorkflowScenarioCard } from "./ScenarioCard";
import { getWorkflowCardReplayScript, type ReplayScript } from "./replay";
import { hasLazyReplayScript } from "./replay/availability";
import { TECHNICAL_INQUIRY_TRACE_SCENARIO_ID } from "./replay/technicalInquiryTraceMeta";
import { matchRoleIdByPosition, useScenarioLibrary } from "./useScenarioLibrary";
import { RoleKitDetailPage } from "./RoleKitDetailPage";
import { INDUSTRY_ALL, matchIndustry, type IndustryFilterValue } from "./useIndustryFilter";
import { useScenarioFilters } from "./useScenarioFilters";
import { friendlyIndustry } from "./friendlyMappings";
import { OUTCOME_ICON } from "./outcomeIcons";
import { WorkflowCatalogSkeleton } from "./WorkflowCatalogSkeleton";
import {
  filterWorkflowScenarios,
  isHookScenario,
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
  workflowTrialMessage,
} from "./workflowUi";

const INDUSTRY_ORDER: IndustryType[] = ["manufacturing", "trade", "retail", "service", "export", "ecommerce"];
const INDUSTRY_CHIPS = INDUSTRY_ORDER.map((id) => ({ value: id, label: friendlyIndustry[id] }));
const ScenarioReplayView = lazy(() =>
  import("./replay/ScenarioReplayView").then((module) => ({ default: module.ScenarioReplayView })),
);
const ScenarioDetailDialog = lazy(() =>
  import("./ScenarioDetailDialog").then((module) => ({ default: module.ScenarioDetailDialog })),
);

export interface ScenariosPanelProps {
  onTryScenario: (prompt: string, scenario: ScenarioItem) => void;
  onStartWorkflow?: (starterMessage: string, scenario: CatalogScenarioPublic) => void;
  onConnectWorkflow?: (workflowId: string) => void;
  onRequestDiagnosis?: (message: string, scenario: CatalogScenarioPublic) => void;
  onWorkflowSelected?: (scenario: CatalogScenarioPublic) => void;
  onReplayOpenChange?: (open: boolean) => void;
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
  const [replay, setReplay] = useState<ReplayScript | null>(null);
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [deferredNotice, setDeferredNotice] = useState<WorkflowLibraryPublicV3["deferredObjects"][number] | null>(null);
  const deepLinkConsumed = useRef(false);
  const userSelectedRole = useRef(false);
  const replayRequest = useRef(0);

  useEffect(() => {
    props.onReplayOpenChange?.(replay !== null);
  }, [props.onReplayOpenChange, replay]);
  useEffect(() => () => props.onReplayOpenChange?.(false), [props.onReplayOpenChange]);

  const workflowLibrary = result.workflowLibrary ?? null;
  const roles = workflowLibrary?.roles ?? result.library?.roles ?? [];

  useEffect(() => {
    if (userSelectedRole.current || filters.activeRole !== ROLE_ALL) return;
    const requested =
      props.roleDetailId ?? user?.preferences?.activeRoleId ?? matchRoleIdByPosition(roles, user?.position);
    if (requested && roles.some((role) => role.id === requested)) filters.setActiveRole(requested);
  }, [
    filters.activeRole,
    filters.setActiveRole,
    props.roleDetailId,
    roles,
    user?.position,
    user?.preferences?.activeRoleId,
  ]);

  const handleWorkflowAction = (action: WorkflowPrimaryAction, scenario: CatalogScenarioPublic) => {
    const requestId = ++replayRequest.current;
    props.onWorkflowSelected?.(scenario);
    if (action === "presentation") {
      if (scenario.id === TECHNICAL_INQUIRY_TRACE_SCENARIO_ID) {
        void import("./replay/technicalInquiryTraceScript")
          .then(({ buildTechnicalInquiryTraceScript }) => {
            if (replayRequest.current === requestId) setReplay(buildTechnicalInquiryTraceScript(scenario));
          })
          .catch(() => {
            if (replayRequest.current === requestId) setDetail({ scenario });
          });
        return;
      }
      // 七类 Hero 与钩子剧本体积大，按需装载；失败回落到详情弹窗
      if (hasLazyReplayScript(scenario.id)) {
        void import("./replay/lazyRegistry")
          .then(({ loadLazyReplayScript }) => loadLazyReplayScript(scenario.id))
          .then((script) => {
            if (replayRequest.current !== requestId) return;
            setReplay(script ?? getWorkflowCardReplayScript(scenario));
          })
          .catch(() => {
            if (replayRequest.current === requestId) setReplay(getWorkflowCardReplayScript(scenario));
          });
        return;
      }
      // 静态剧本与其他 Workflow V3 presentation 继续走原生会话回放。
      setReplay(getWorkflowCardReplayScript(scenario));
      return;
    }
    if (action === "chat") {
      if (props.onStartWorkflow) props.onStartWorkflow(workflowTrialMessage(scenario), scenario);
      else setDetail({ scenario });
      return;
    }
    if (action === "connector") {
      if (props.onConnectWorkflow) props.onConnectWorkflow(scenario.workflowId);
      else setDetail({ scenario });
      return;
    }
    if (action === "diagnosis") {
      if (props.onRequestDiagnosis) {
        props.onRequestDiagnosis(
          `我想为「${scenario.title}」预约落地诊断，请先确认业务边界、现有系统和所需人审。`,
          scenario,
        );
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
    } else if (intent === "presentation") {
      // 首屏推荐卡的「看回放」：切到能力中心后直接进回放，不停在详情弹窗
      setDetail(null);
      handleWorkflowAction("presentation", resolved.scenario);
    }
    // handleWorkflowAction 只消费当前 props；deep link 明确只运行一次。
  }, [workflowLibrary]);

  if (result.loading) {
    return (
      <div className="w-full px-4 pb-4 pt-6 sm:px-6 sm:pb-6">
        <WorkflowCatalogSkeleton />
      </div>
    );
  }
  if (result.error || (!workflowLibrary && !result.library)) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
        <SearchX className="size-8 opacity-60" aria-hidden="true" />
        <div>
          <div className="text-sm font-medium text-foreground">AI 同事工作流暂时不可用</div>
          <p className="mt-1 text-xs">{result.error || "工作流目录加载失败，请稍后重试。"}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={retrying}
          onClick={() => {
            setRetrying(true);
            result.reload();
            window.setTimeout(() => setRetrying(false), 500);
          }}
        >
          {retrying ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {retrying ? "重试中" : "重试"}
        </Button>
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

  // 钩子场景只在「从一句话或业务事件开始」区出现；全部工作场景目录保持 28 条闭环工作流
  const catalogScenarios = workflowLibrary.scenarios.filter((scenario) => !isHookScenario(scenario));
  const roleLabels = Object.fromEntries(workflowLibrary.roles.map((role) => [role.id, role.name]));
  const scenarios = filterWorkflowScenarios(catalogScenarios, {
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
  const hasFilters =
    filters.activeOutcome !== OUTCOME_ALL ||
    filters.activeRole !== ROLE_ALL ||
    filters.activeIndustry !== INDUSTRY_ALL ||
    filters.activeVertical !== VERTICAL_ALL ||
    filters.activeBusinessModel !== BUSINESS_MODEL_ALL ||
    filters.activeMaturity !== MATURITY_ALL;
  const secondaryFiltersActive =
    filters.activeIndustry !== INDUSTRY_ALL ||
    filters.activeVertical !== VERTICAL_ALL ||
    filters.activeBusinessModel !== BUSINESS_MODEL_ALL ||
    filters.activeMaturity !== MATURITY_ALL;
  const secondaryFilterCount = [
    filters.activeIndustry !== INDUSTRY_ALL,
    filters.activeVertical !== VERTICAL_ALL,
    filters.activeBusinessModel !== BUSINESS_MODEL_ALL,
    filters.activeMaturity !== MATURITY_ALL,
  ].filter(Boolean).length;
  const outcomeFilterOptions = [
    {
      value: OUTCOME_ALL,
      label: "全部结果",
      count: catalogScenarios.length,
      icon: <Target className="size-3.5" />,
    },
    ...OUTCOME_OPTIONS.map((value) => {
      const Icon = OUTCOME_ICON[value];
      return {
        value,
        label: value,
        count: catalogScenarios.filter((scenario) => scenario.goalTags.includes(value)).length,
        icon: <Icon className="size-3.5" />,
      };
    }),
  ];
  const activeFilterChips = [
    filters.activeOutcome !== OUTCOME_ALL
      ? { label: filters.activeOutcome, clear: () => filters.setActiveOutcome(OUTCOME_ALL) }
      : null,
    filters.activeRole !== ROLE_ALL
      ? {
          label: workflowLibrary.roles.find((role) => role.id === filters.activeRole)?.name ?? filters.activeRole,
          clear: () => filters.setActiveRole(ROLE_ALL),
        }
      : null,
    filters.activeIndustry !== INDUSTRY_ALL
      ? {
          label: friendlyIndustry[filters.activeIndustry],
          clear: () => filters.setActiveIndustry(INDUSTRY_ALL),
        }
      : null,
    filters.activeVertical !== VERTICAL_ALL
      ? { label: filters.activeVertical, clear: () => filters.setActiveVertical(VERTICAL_ALL) }
      : null,
    filters.activeBusinessModel !== BUSINESS_MODEL_ALL
      ? {
          label: filters.activeBusinessModel,
          clear: () => filters.setActiveBusinessModel(BUSINESS_MODEL_ALL),
        }
      : null,
    filters.activeMaturity !== MATURITY_ALL
      ? { label: filters.activeMaturity, clear: () => filters.setActiveMaturity(MATURITY_ALL) }
      : null,
  ].filter((item): item is { label: string; clear: () => void } => item !== null);

  // 回放接管整个主区：左侧会话栏在外层布局，不受影响
  if (replay) {
    return (
      <Suspense
        fallback={
          <div className="flex min-h-80 items-center justify-center">
            <Loader2 className="size-5 animate-spin" />
          </div>
        }
      >
        <ScenarioReplayView
          script={replay}
          onExit={() => {
            const params = new URLSearchParams(window.location.search);
            params.set("intent", "view");
            window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
            setReplay(null);
          }}
        />
      </Suspense>
    );
  }

  return (
    <div className="w-full px-4 pb-4 sm:px-6 sm:pb-6 md:pt-6">
      <CatalogHeader
        level={1}
        title={roleDetailName ? `${roleDetailName}的 AI 同事能做的事` : "AI 同事能做的事"}
        description="按目标或岗位挑一个，先看演示，再实际融入你的工作流"
        actions={
          roleDetailName && props.onCloseRoleDetail ? (
            <Button variant="outline" size="sm" onClick={props.onCloseRoleDetail}>
              返回目录
            </Button>
          ) : null
        }
      />

      <div className="sticky top-0 z-10 -mx-4 mb-5 border-y border-border/50 bg-card/85 px-4 py-3 backdrop-blur-sm sm:-mx-6 sm:px-6">
        <div className="flex items-center gap-3">
          <CapabilityFilterTabs
            ariaLabel="按业务结果筛选"
            options={outcomeFilterOptions}
            value={filters.activeOutcome}
            onValueChange={(value) => filters.setActiveOutcome(value as OutcomeFilterValue)}
            className="min-w-0 flex-1 pb-0"
          />
          <div className="flex shrink-0 items-center gap-2">
            <Select
              value={filters.activeRole}
              onValueChange={(value) => {
                userSelectedRole.current = true;
                filters.setActiveRole(value);
              }}
            >
              <SelectTrigger aria-label="按岗位筛选" className="h-8 w-[8.5rem] rounded-full bg-card px-2.5 shadow-none">
                <BriefcaseBusiness className="size-3.5 shrink-0 text-muted-foreground" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ROLE_ALL}>全部岗位</SelectItem>
                {workflowLibrary.roles.map((role) => (
                  <SelectItem key={role.id} value={role.id}>
                    {role.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Popover open={moreFiltersOpen} onOpenChange={setMoreFiltersOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={cn(
                    "h-8 rounded-full px-2.5",
                    secondaryFiltersActive && "border-brand-200 bg-brand-50 text-brand-700",
                  )}
                  aria-label={secondaryFilterCount > 0 ? `更多筛选，已启用 ${secondaryFilterCount} 项` : "更多筛选"}
                >
                  <ListFilter className="size-3.5" />
                  <span className="hidden sm:inline">筛选</span>
                  {secondaryFilterCount > 0 ? (
                    <span className="rounded-full bg-brand-100 px-1.5 text-2xs tabular-nums text-brand-700">
                      {secondaryFilterCount}
                    </span>
                  ) : null}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[min(42rem,calc(100vw-2rem))] space-y-4 rounded-xl p-4">
                <SecondaryFilterGroup label="业务入口">
                  <CapabilityFilterTabs
                    ariaLabel="按业务入口筛选"
                    options={[{ value: INDUSTRY_ALL, label: "全部行业" }, ...INDUSTRY_CHIPS]}
                    value={filters.activeIndustry}
                    onValueChange={(value) => filters.setActiveIndustry(value as IndustryFilterValue)}
                    wrap
                  />
                </SecondaryFilterGroup>
                <SecondaryFilterGroup label="垂直行业">
                  <CapabilityFilterTabs
                    ariaLabel="按垂直行业筛选"
                    options={[
                      { value: VERTICAL_ALL, label: "全部垂直行业" },
                      ...verticalOptions.map((value) => ({ value, label: value })),
                    ]}
                    value={filters.activeVertical}
                    onValueChange={(value) => filters.setActiveVertical(value as VerticalFilterValue)}
                    wrap
                  />
                </SecondaryFilterGroup>
                <SecondaryFilterGroup label="经营模式">
                  <CapabilityFilterTabs
                    ariaLabel="按经营模式筛选"
                    options={[
                      { value: BUSINESS_MODEL_ALL, label: "全部经营模式" },
                      ...businessModelOptions.map((value) => ({ value, label: value })),
                    ]}
                    value={filters.activeBusinessModel}
                    onValueChange={(value) => filters.setActiveBusinessModel(value as BusinessModelFilterValue)}
                    wrap
                  />
                </SecondaryFilterGroup>
                <SecondaryFilterGroup label="数字化基础">
                  <CapabilityFilterTabs
                    ariaLabel="按数字化基础筛选"
                    options={[
                      { value: MATURITY_ALL, label: "全部数字化基础" },
                      ...maturityOptions.map((value) => ({ value, label: value })),
                    ]}
                    value={filters.activeMaturity}
                    onValueChange={(value) => filters.setActiveMaturity(value as MaturityFilterValue)}
                    wrap
                  />
                </SecondaryFilterGroup>
              </PopoverContent>
            </Popover>
            {hasFilters ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 rounded-full"
                onClick={filters.clearFilters}
                aria-label="清空筛选"
              >
                <RotateCcw className="size-3.5" />
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {scenarios.length === 0 ? (
        <div
          className={cn(
            "flex flex-col items-center px-6 py-12 text-center text-sm text-muted-foreground",
            CAPABILITY_EMPTY_SURFACE,
          )}
        >
          <SearchX className="size-8 opacity-60" aria-hidden="true" />
          <div className="mt-3 font-medium text-foreground">没有同时满足这些条件的工作流</div>
          <p className="mt-1 text-xs">移除一项条件，或重置后重新浏览完整目录。</p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {activeFilterChips.map((item) => (
              <button
                key={item.label}
                type="button"
                className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-xs text-foreground transition-colors hover:border-brand-200 hover:bg-brand-50"
                onClick={item.clear}
                aria-label={`移除筛选：${item.label}`}
              >
                {item.label}
                <X className="size-3" />
              </button>
            ))}
          </div>
          <Button type="button" variant="outline" size="sm" className="mt-4" onClick={filters.clearFilters}>
            重置全部筛选
          </Button>
        </div>
      ) : (
        <div
          key={`${filters.activeOutcome}-${filters.activeRole}-${filters.activeIndustry}-${filters.activeVertical}-${filters.activeBusinessModel}-${filters.activeMaturity}`}
          className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
          data-testid="workflow-catalog"
        >
          {scenarios.map((scenario, index) => (
            <WorkflowScenarioCard
              key={scenario.id}
              scenario={scenario}
              roleLabels={roleLabels}
              className="cap-grid-item"
              style={{ "--i": Math.min(index, 12) } as CSSProperties}
              onOpenDetail={(scenario) => {
                props.onWorkflowSelected?.(scenario);
                setDetail({ scenario });
              }}
              onPrimaryAction={handleWorkflowAction}
            />
          ))}
        </div>
      )}

      {detail ? (
        <Suspense fallback={null}>
          <ScenarioDetailDialog
            scenario={detail.scenario}
            library={workflowLibrary}
            vertical={filters.activeVertical}
            businessModel={filters.activeBusinessModel}
            maturity={filters.activeMaturity}
            skinId={detail.skinId}
            roleViewId={detail.roleViewId}
            roleId={detail.roleId ?? (filters.activeRole === ROLE_ALL ? null : filters.activeRole)}
            open
            onOpenChange={(open) => {
              if (!open) setDetail(null);
            }}
            onPrimaryAction={handleWorkflowAction}
          />
        </Suspense>
      ) : null}
      <Dialog
        open={!!deferredNotice}
        onOpenChange={(open) => {
          if (!open) setDeferredNotice(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>当前未作为标准工作流开放</DialogTitle>
            <DialogDescription className="text-left leading-6">{deferredNotice?.reason}</DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            该旧入口不会启动聊天或模拟运行。你可以返回目录选择已经开放的工作流。
          </p>
          <DialogFooter>
            <Button type="button" onClick={() => setDeferredNotice(null)}>
              返回工作流目录
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "zh-CN"));
}

function SecondaryFilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-2 text-xs font-medium text-muted-foreground">{label}</div>
      {children}
    </div>
  );
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
    const preferred =
      user?.preferences?.activeRoleId && library.roles.some((role) => role.id === user.preferences?.activeRoleId)
        ? user.preferences.activeRoleId
        : matchRoleIdByPosition(library.roles, user?.position);
    if (preferred) setActiveRole(preferred);
  }, [library.roles, user?.position, user?.preferences?.activeRoleId]);

  const scenarios = useMemo(
    () =>
      library.scenarios.filter((scenario) => {
        if (!matchIndustry(scenario.industryFocus, industry)) return false;
        return activeRole === "all" || scenario.role === activeRole;
      }),
    [activeRole, industry, library.scenarios],
  );
  const roleDetail = library.roles.find((role) => role.id === roleDetailId) ?? null;
  const roleNameById = new Map(library.roles.map((role) => [role.id, role.name]));
  const handleTry = (scenario: ScenarioItem) => {
    setDetail(null);
    onTryScenario(buildScenarioPrompt(scenario), scenario);
  };

  if (roleDetail) {
    return (
      <RoleKitDetailPage
        role={roleDetail}
        scenarios={library.scenarios}
        industryHint={user?.preferences?.industryHint}
        onTryScenario={handleTry}
        onBack={onCloseRoleDetail}
      />
    );
  }

  return (
    <div className="w-full px-4 pb-4 sm:px-6 sm:pb-6 md:pt-6">
      {fallbackReason ? (
        <div role="status" className="mb-4 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-sm">
          当前显示兼容目录。
        </div>
      ) : null}
      <CatalogHeader
        level={1}
        title="任务模板"
        description={
          fallbackReason
            ? "兼容目录仍按起手话术运行。"
            : "按岗位挑一个任务模板，点「试一试」即可预填起手话术，发送前仍可编辑。"
        }
        actions={
          activeRole !== "all" && onOpenRoleDetail ? (
            <Button variant="outline" size="sm" onClick={() => onOpenRoleDetail(activeRole)}>
              查看该岗详情
            </Button>
          ) : null
        }
      />
      <CapabilityFilterTabs
        ariaLabel="按行业筛选"
        options={[{ value: INDUSTRY_ALL, label: "全部行业" }, ...INDUSTRY_CHIPS]}
        value={industry}
        onValueChange={(value) => setIndustry(value as IndustryFilterValue)}
        className="mb-3"
      />
      <CapabilityFilterTabs
        ariaLabel="按岗位筛选"
        options={[
          { value: "all", label: "全部" },
          ...library.roles.map((role) => ({ value: role.id, label: role.name })),
        ]}
        value={activeRole}
        onValueChange={(value) => {
          userSelectedRole.current = true;
          setActiveRole(value);
        }}
        className="mb-5"
      />
      {scenarios.length === 0 ? (
        <div className="py-16 text-center text-sm text-muted-foreground">
          {industry !== INDUSTRY_ALL
            ? `${friendlyIndustry[industry]}行业暂无匹配任务模板，试试切换到「全部行业」`
            : "该岗位暂无任务模板"}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {scenarios.map((scenario) => (
            <ScenarioCard key={scenario.id} scenario={scenario} onTry={handleTry} onOpenDetail={setDetail} />
          ))}
        </div>
      )}
      <Dialog
        open={!!detail}
        onOpenChange={(open) => {
          if (!open) setDetail(null);
        }}
      >
        <DialogContent className="max-w-lg">
          {detail ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 pr-6">
                  <span>{detail.title}</span>
                  <ScenarioModeBadge mode={detail.mode} />
                </DialogTitle>
                <DialogDescription className="text-left">{detail.pitch}</DialogDescription>
              </DialogHeader>
              <div className="space-y-4 text-sm">
                <div className="text-xs text-muted-foreground">
                  岗位：{roleNameById.get(detail.role) ?? detail.role}
                </div>
                <ol className="space-y-2">
                  {detail.story.split("→").map((step, index) => (
                    <li key={`${step}-${index}`} className="flex gap-2">
                      <span>{index + 1}.</span>
                      <span className="text-muted-foreground">{step.trim()}</span>
                    </li>
                  ))}
                </ol>
                {detail.slots.length > 0 ? (
                  <div>
                    <div className="mb-2 font-medium">需要你补充的信息</div>
                    <ul className="space-y-1.5">
                      {detail.slots.map((slot) => (
                        <li key={slot.key} className="text-muted-foreground">
                          <span className="text-foreground">{slot.label}</span>
                          <span className="mx-1">·</span>示例：{slot.example}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <ScenarioRequireBadges requires={detail.requires} />
              </div>
              <DialogFooter>
                <Button onClick={() => handleTry(detail)}>试一试</Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
