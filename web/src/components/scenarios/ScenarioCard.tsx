/**
 * 场景卡片与徽标原语
 *
 * 被场景库整页（ScenariosPanel）与空会话推荐位（EmptySessionScenarios）共用。
 * 有意与 ScenariosPanel 拆成独立小模块：推荐位随聊天主视图打包，
 * 整页面板走 lazy 加载，避免互相拖入对方的 bundle。
 */
import { lazy, Suspense, useState, type CSSProperties } from "react";
import { ArrowRight, Globe, MessageSquareShare, Play, Repeat, ShieldAlert, Upload, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CAPABILITY_SURFACE, CAPABILITY_SURFACE_HOVER } from "@/components/CapabilityCenter/CatalogUi";
import type { CatalogScenarioPublic, ScenarioItem, ScenarioRequirement } from "@agent/shared";
import type { WorkflowPrimaryAction } from "./workflowUi";

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
  /** 岗位 id → 展示名；缺失时回退到 id */
  roleLabels?: Record<string, string>;
  onOpenDetail: (scenario: CatalogScenarioPublic) => void;
  onPrimaryAction: (action: WorkflowPrimaryAction, scenario: CatalogScenarioPublic) => void;
  compact?: boolean;
  className?: string;
  style?: CSSProperties;
}

/** 岗位行最多直接列出的数量，超出部分折成「+N」 */
const ROLE_PREVIEW_COUNT = 3;

/**
 * V3 客户目录卡（09-04 曾磊定稿）：标题是主角，其余只有一行标签和一行页脚。
 * 结构 = 标题（两行封顶）→ 目标标签 + 岗位 → hairline 页脚（触发时机 | 演示 / 试试）。
 * 两个动作同级同形，只用色相区分：演示=品牌暖橙，试试=品牌蓝；卡内不出现第三种颜色。
 * 不消费 prompt、tool 或旧 demoShareToken。
 */
export function WorkflowScenarioCard({
  scenario,
  roleLabels,
  onOpenDetail,
  onPrimaryAction,
  className,
  style,
}: WorkflowScenarioCardProps) {
  const goal = scenario.goalTags[0];
  const roleNames = scenario.roleIds.map((id) => roleLabels?.[id] ?? id);
  const hiddenRoleCount = roleNames.length - ROLE_PREVIEW_COUNT;
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
        "group relative flex cursor-pointer flex-col rounded-2xl p-4 text-left text-card-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400 focus-visible:ring-offset-2",
        CAPABILITY_SURFACE,
        CAPABILITY_SURFACE_HOVER,
        className,
      )}
    >
      <h3 className="line-clamp-2 text-[15px] font-semibold leading-snug tracking-tight transition-colors group-hover:text-brand-700">
        {scenario.title}
      </h3>
      <div className="mb-3.5 mt-2 flex items-center gap-2 overflow-hidden whitespace-nowrap text-xs text-muted-foreground">
        {goal ? (
          <span className="shrink-0 rounded-md bg-brand-50 px-1.5 py-0.5 text-2xs font-medium text-brand-700">
            {goal}
          </span>
        ) : null}
        <span className="truncate">
          {roleNames.slice(0, ROLE_PREVIEW_COUNT).join(" · ")}
          {hiddenRoleCount > 0 ? <span className="text-muted-foreground/60"> +{hiddenRoleCount}</span> : null}
        </span>
      </div>
      <div
        className="mt-auto flex items-center gap-1.5 border-t border-border/50 pt-3"
        data-workflow-actions
      >
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0 rounded bg-muted px-1.5 py-px text-2xs text-muted-foreground/70">触发</span>
          <span className="truncate">{scenario.triggerBadge}</span>
        </span>
        <span className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1 rounded-full bg-brand-accent-soft px-3 text-xs font-medium text-brand-accent-ink hover:bg-brand-accent/25 hover:text-brand-accent-ink"
          onClick={(event) => {
            event.stopPropagation();
            onPrimaryAction("presentation", scenario);
          }}
        >
          <Play className="size-3.5 fill-current" aria-hidden="true" />
          演示
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1 rounded-full bg-brand-50 px-3 text-xs font-medium text-brand-700 hover:bg-brand-600 hover:text-white"
          onClick={(event) => {
            event.stopPropagation();
            onPrimaryAction("chat", scenario);
          }}
        >
          试试
          <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
        </Button>
      </div>
    </article>
  );
}
