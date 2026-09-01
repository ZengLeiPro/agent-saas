/**
 * 场景卡片与徽标原语
 *
 * 被场景库整页（ScenariosPanel）与空会话推荐位（EmptySessionScenarios）共用。
 * 有意与 ScenariosPanel 拆成独立小模块：推荐位随聊天主视图打包，
 * 整页面板走 lazy 加载，避免互相拖入对方的 bundle。
 */
import { lazy, Suspense, useState, type CSSProperties } from "react";
import { Globe, MessageSquareShare, Repeat, ShieldAlert, Target, Upload, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CAPABILITY_SURFACE, CAPABILITY_SURFACE_HOVER } from "@/components/CapabilityCenter/CatalogUi";
import type { CatalogScenarioPublic, ScenarioItem, ScenarioRequirement } from "@agent/shared";
import { friendlyPrimaryType, friendlyReadiness } from "./friendlyMappings";
import { OUTCOME_ICON } from "./outcomeIcons";
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
      {mode === "recurring" ? (
        <>
          <Repeat className="size-3" aria-hidden="true" />
          常驻
        </>
      ) : (
        <>
          <Zap className="size-3" aria-hidden="true" />
          一次性
        </>
      )}
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
            className="inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-xs text-muted-foreground"
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
          "flex flex-col gap-2 p-4 text-left text-card-foreground",
          CAPABILITY_SURFACE,
          clickable && cn("cursor-pointer", CAPABILITY_SURFACE_HOVER),
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
  /** 同屏只强调一个主动作，避免多个实心品牌色同时争夺注意力。 */
  emphasizePrimary?: boolean;
  className?: string;
  style?: CSSProperties;
}

/** V3 客户目录卡；不消费 prompt、tool 或旧 demoShareToken。 */
export function WorkflowScenarioCard({
  scenario,
  onOpenDetail,
  onPrimaryAction,
  emphasizePrimary = false,
  className,
  style,
}: WorkflowScenarioCardProps) {
  const cta = workflowCta(scenario);
  const outcome = scenario.goalTags[0] ?? "控风险";
  const OutcomeIcon = OUTCOME_ICON[outcome as keyof typeof OUTCOME_ICON] ?? Target;
  return (
    <article
      style={style}
      // 整卡可点，与技能、连接器、专家目录的卡片保持同一套交互模型
      role="button"
      tabIndex={0}
      aria-label={`查看 ${scenario.title} 详情`}
      onClick={() => onOpenDetail(scenario)}
      onKeyDown={(event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenDetail(scenario);
        }
      }}
      className={cn(
        "group relative flex min-h-[13.5rem] cursor-pointer flex-col overflow-hidden p-4 text-left text-card-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2",
        CAPABILITY_SURFACE,
        CAPABILITY_SURFACE_HOVER,
        scenario.featured &&
          "ring-brand-200/70 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-gradient-to-b before:from-brand-500 before:to-brand-600",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        {/* 形态（4 选 1 的短词）挪到这里，用掉标签行原本的空白，
            把底部整行让给逐条不同的人审说明——否则两者挤一行会把人审说明截到只剩七八个字 */}
        <span className="flex min-w-0 items-center gap-1.5">
          <OutcomeIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{outcome}</span>
          <span className="shrink-0 text-muted-foreground/40" aria-hidden="true">
            ·
          </span>
          <span className="shrink-0 text-muted-foreground/80">{friendlyPrimaryType[scenario.primaryType]}</span>
          {scenario.featured ? <span className="sr-only">重点工作流</span> : null}
        </span>
        {/* 目录里 22/28 都是「标准接入」，这一格几乎没有区分度；
            把颜色只留给「当前即用」——那是能立刻上手、值得被看见的那一档 */}
        <span
          className={cn(
            "shrink-0 text-2xs",
            scenario.readiness === "D0_CURRENT" && "font-medium text-success-ink",
          )}
          title={`接入就绪度：${friendlyReadiness[scenario.readiness]}`}
        >
          {friendlyReadiness[scenario.readiness]}
        </span>
      </div>
      <h3 className="mt-4 text-base font-semibold leading-snug transition-colors group-hover:text-brand-600">
        {scenario.title}
      </h3>
      <p className="mt-2 line-clamp-2 text-sm leading-5 text-muted-foreground">{scenario.value}</p>
      {/*
        这里刻意不用 shortChain：目录里 28 条工作流的 shortChain 只有 4 种取值，
        且与 primaryType 一一对应（15/4/3/6），等于把底部那个词换行重排了一遍。
        triggerBadge 是 28 条各不相同的字段，补上卡片缺的「什么时候会触发」。
      */}
      <div className="mt-3 flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground/80">
        <Zap className="size-3 shrink-0 opacity-60" aria-hidden="true" />
        <span className="min-w-0 truncate" title={scenario.triggerBadge}>
          {scenario.triggerBadge}
        </span>
      </div>
      <div className="mt-auto flex items-center justify-between gap-3 border-t border-border/50 pt-4">
        <div
          className="min-w-0 truncate text-2xs leading-4 text-muted-foreground"
          title={scenario.humanApprovalSummary}
        >
          {scenario.humanApprovalSummary}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2">
          {cta.secondaryLabel ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-3 text-xs text-muted-foreground hover:text-foreground"
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
            variant="outline"
            size="sm"
            className={cn(
              "h-8 px-3 text-xs transition-colors duration-200",
              emphasizePrimary
                ? "border-brand-600 bg-brand-600 text-white hover:border-brand-700 hover:bg-brand-700 hover:text-white"
                : // 静态就带一层弱品牌底：扫视阶段（还没 hover）也要能看出哪个是主动作，
                  // 否则「看演示」和「接入我的系统」长得一样，后者却是接生产系统的重承诺
                  "border-brand-200 bg-brand-50 text-brand-700 group-hover:border-brand-600 group-hover:bg-brand-600 group-hover:text-white group-focus-within:border-brand-600 group-focus-within:bg-brand-600 group-focus-within:text-white",
            )}
            onClick={(event) => {
              event.stopPropagation();
              onPrimaryAction(cta.action, scenario);
            }}
          >
            {cta.label}
          </Button>
        </div>
      </div>
    </article>
  );
}
