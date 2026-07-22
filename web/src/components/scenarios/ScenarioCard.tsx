/**
 * 场景卡片与徽标原语
 *
 * 被场景库整页（ScenariosPanel）与空会话推荐位（EmptySessionScenarios）共用。
 * 有意与 ScenariosPanel 拆成独立小模块：推荐位随聊天主视图打包，
 * 整页面板走 lazy 加载，避免互相拖入对方的 bundle。
 */
import { lazy, Suspense, useState } from "react";
import { Activity, Globe, MessageSquareShare, MousePointerClick, Repeat, ShieldAlert, Upload, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { CatalogScenarioPublic, ScenarioItem, ScenarioRequirement } from "@agent/shared";
import { friendlyPrimaryType, friendlyReadiness } from "./friendlyMappings";
import { workflowCta, type WorkflowPrimaryAction } from "./workflowUi";

// 懒加载：仅点开「看示例结果」时才拉取弹层（内含 markdown 渲染），
// 不拖累空会话推荐位所在的聊天主 bundle
const ScenarioExampleDialogLazy = lazy(() => import("./ScenarioExampleDialog"));

export function scenarioDemoSharePath(scenario: ScenarioItem): string | null {
  const token = scenario.demoShareToken?.trim();
  if (!token) return null;
  const params = new URLSearchParams({ scenario: scenario.id });
  return `/share/${encodeURIComponent(token)}?${params.toString()}`;
}

/** 形态徽标：recurring → 常驻；oneshot → 一次性 */
export function ScenarioModeBadge({ mode }: { mode: ScenarioItem["mode"] }) {
  return (
    <Badge variant="secondary" className="shrink-0 gap-1 font-normal">
      {mode === "recurring"
        ? <><Repeat className="size-3" aria-hidden="true" />常驻</>
        : <><Zap className="size-3" aria-hidden="true" />一次性</>}
    </Badge>
  );
}

const REQUIREMENT_META: Record<
  Exclude<ScenarioRequirement, "internal_system">,
  { label: string; Icon: typeof Globe }
> = {
  web: { label: "联网检索", Icon: Globe },
  dingtalk: { label: "钉钉推送", Icon: MessageSquareShare },
  upload: { label: "需上传资料", Icon: Upload },
};

/** requires 角标：internal_system 用提示样式单独强调，其余为轻量图标+文字 */
export function ScenarioRequireBadges({
  requires,
  className,
}: {
  requires: ScenarioRequirement[];
  className?: string;
}) {
  if (requires.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {requires.map((req) => {
        if (req === "internal_system") {
          return (
            <span
              key={req}
              className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-xs text-foreground/80"
            >
              <ShieldAlert className="size-3" />
              需管理员配置系统对接
            </span>
          );
        }
        const meta = REQUIREMENT_META[req];
        if (!meta) return null;
        const { label, Icon } = meta;
        return (
          <span
            key={req}
            className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
          >
            <Icon className="size-3" />
            {label}
          </span>
        );
      })}
    </div>
  );
}

interface ScenarioCardProps {
  scenario: ScenarioItem;
  /** 点「试一试」：由上层负责新建会话/预填输入框 */
  onTry: (scenario: ScenarioItem) => void;
  /** 点卡片本体：打开详情（可选，空会话推荐位不带详情） */
  onOpenDetail?: (scenario: ScenarioItem) => void;
  /** 紧凑模式：空会话推荐位使用，隐藏 requires 角标以降低视觉噪音 */
  compact?: boolean;
}

export function ScenarioCard({ scenario, onTry, onOpenDetail, compact }: ScenarioCardProps) {
  const clickable = !!onOpenDetail;
  const demoSharePath = scenarioDemoSharePath(scenario);
  const hasExample = !!scenario.exampleResult || !!demoSharePath;
  const [exampleOpen, setExampleOpen] = useState(false);
  return (
    <>
    <div
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? () => onOpenDetail(scenario) : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpenDetail(scenario);
              }
            }
          : undefined
      }
      className={cn(
        "flex flex-col gap-2 rounded-lg border bg-card p-4 text-left text-card-foreground shadow-sm transition-shadow",
        clickable && "cursor-pointer hover:shadow-[0_2px_8px_-2px_rgba(15,23,42,0.18)]",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-semibold leading-snug">{scenario.title}</div>
        <ScenarioModeBadge mode={scenario.mode} />
      </div>
      <p className={cn("text-sm text-muted-foreground", compact ? "line-clamp-2" : "line-clamp-3")}>
        {scenario.pitch}
      </p>
      {!compact && <ScenarioRequireBadges requires={scenario.requires} className="mt-auto" />}
      <div className={cn("flex items-center justify-end gap-2", compact ? "mt-auto" : "pt-1")}>
        {hasExample ? (
          <>
            {/* 原预填按钮保留为次按钮：行为不变，文案改为「换成我的资料」 */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-3 text-xs"
              onClick={(e) => {
                // 阻止冒泡：避免同时触发卡片的「打开详情」
                e.stopPropagation();
                onTry(scenario);
              }}
            >
              换成我的资料
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-7 px-3 text-xs"
              onClick={(e) => {
                e.stopPropagation();
                if (demoSharePath) {
                  window.location.assign(demoSharePath);
                  return;
                }
                setExampleOpen(true);
              }}
            >
              看示例结果
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            className="h-7 px-3 text-xs"
            onClick={(e) => {
              // 阻止冒泡：避免同时触发卡片的「打开详情」
              e.stopPropagation();
              onTry(scenario);
            }}
          >
            试一试
          </Button>
        )}
      </div>
    </div>
    {/* 弹层挂在卡片 div 的兄弟位置：Portal 内的合成事件不会冒泡进卡片的「打开详情」 */}
    {scenario.exampleResult && exampleOpen && (
      <Suspense fallback={null}>
        <ScenarioExampleDialogLazy
          scenario={scenario}
          open={exampleOpen}
          onOpenChange={setExampleOpen}
          onUseMyData={(s) => {
            setExampleOpen(false);
            onTry(s);
          }}
        />
      </Suspense>
    )}
    </>
  );
}

export interface WorkflowScenarioCardProps {
  scenario: CatalogScenarioPublic;
  onOpenDetail: (scenario: CatalogScenarioPublic) => void;
  onPrimaryAction: (action: WorkflowPrimaryAction, scenario: CatalogScenarioPublic) => void;
  compact?: boolean;
}

/** V3 客户目录卡；不消费 prompt、tool 或旧 demoShareToken。 */
export function WorkflowScenarioCard({
  scenario,
  onOpenDetail,
  onPrimaryAction,
  compact,
}: WorkflowScenarioCardProps) {
  const cta = workflowCta(scenario);
  return (
    <article
      className={cn(
        "flex flex-col rounded-xl border bg-card p-4 text-left text-card-foreground shadow-sm transition-shadow",
        "hover:shadow-[0_2px_8px_-2px_rgba(15,23,42,0.18)]",
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {scenario.featured ? (
          <Badge className="bg-brand-50 font-normal text-brand-700 hover:bg-brand-50">重点工作流</Badge>
        ) : null}
        <Badge variant="secondary" className="font-normal">{friendlyPrimaryType[scenario.primaryType]}</Badge>
        <Badge variant="outline" className="font-normal">{friendlyReadiness[scenario.readiness]}</Badge>
        {scenario.demo.evidenceLevel === "workflow_replay" && scenario.demo.sharePath ? (
          <Badge variant="outline" className="gap-1 font-normal">
            <Activity className="size-3" aria-hidden="true" />可核验演示
          </Badge>
        ) : null}
      </div>
      <h3 className="mt-3 text-base font-semibold leading-snug">
        <button type="button" className="text-left hover:text-brand-600" onClick={() => onOpenDetail(scenario)}>
          {scenario.title}
        </button>
      </h3>
      <p className={cn("mt-1.5 text-sm leading-5 text-muted-foreground", compact ? "line-clamp-2" : "line-clamp-3")}>
        {scenario.value}
      </p>
      {!compact ? (
        <ol className="mt-4 flex flex-wrap items-center gap-1 text-xs text-muted-foreground" aria-label="工作流短链">
          {scenario.shortChain.map((step, index) => (
            <li key={`${scenario.id}-${index}`} className="inline-flex items-center gap-1">
              {index > 0 ? <span aria-hidden="true">→</span> : null}
              <span>{step}</span>
            </li>
          ))}
        </ol>
      ) : null}
      <div className="mt-4 grid gap-1.5 text-xs text-muted-foreground">
        <span>触发：{scenario.triggerBadge}</span>
        <span>行动：{scenario.actionBadge}</span>
        <span>人审：{scenario.humanApprovalSummary}</span>
      </div>
      <div className="mt-auto flex items-center justify-end gap-2 pt-4">
        {cta.secondaryLabel ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 px-3 text-xs"
            onClick={(event) => {
              event.stopPropagation();
              if (cta.secondaryAction) onPrimaryAction(cta.secondaryAction, scenario);
              else onOpenDetail(scenario);
            }}
          >
            {cta.secondaryLabel}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          className="h-8 px-3 text-xs"
          onClick={(event) => {
            event.stopPropagation();
            onPrimaryAction(cta.action, scenario);
          }}
        >
          {cta.label}
        </Button>
      </div>
    </article>
  );
}

/** P0 引导演示入口：只讲业务结果和体验方式，不把完整 Workflow 规格塞回首屏。 */
export function WorkflowPresentationCard({
  scenario,
  onPrimaryAction,
}: Pick<WorkflowScenarioCardProps, "scenario" | "onPrimaryAction">) {
  const cta = workflowCta(scenario);
  const chapterCount = scenario.presentation?.chapters.length ?? 0;
  return (
    <article className="flex flex-col overflow-hidden rounded-2xl border border-brand-100 bg-gradient-to-br from-white via-white to-brand-50/70 p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-md">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge className="gap-1 bg-brand-50 font-normal text-brand-700 hover:bg-brand-50">
          <MousePointerClick className="size-3" />一步一步演示
        </Badge>
        <Badge variant="outline" className="font-normal">{friendlyReadiness[scenario.readiness]}</Badge>
      </div>
      <h3 className="mt-4 text-lg font-semibold leading-snug text-slate-950">{scenario.title}</h3>
      <p className="mt-2 line-clamp-3 text-sm leading-6 text-muted-foreground">{scenario.value}</p>
      <div className="mt-4 text-xs font-medium text-brand-700">{chapterCount} 个业务步骤 · 右侧系统状态同步变化</div>
      <div className="mt-auto flex flex-wrap items-center justify-end gap-2 pt-5">
        {cta.secondaryAction && cta.secondaryLabel ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onPrimaryAction(cta.secondaryAction!, scenario)}
          >
            {cta.secondaryLabel}
          </Button>
        ) : null}
        <Button type="button" size="sm" onClick={() => onPrimaryAction("presentation", scenario)}>
          看它如何完成
        </Button>
      </div>
    </article>
  );
}
