/**
 * 场景卡片与徽标原语
 *
 * 被场景库整页（ScenariosPanel）与空会话推荐位（EmptySessionScenarios）共用。
 * 有意与 ScenariosPanel 拆成独立小模块：推荐位随聊天主视图打包，
 * 整页面板走 lazy 加载，避免互相拖入对方的 bundle。
 */
import { lazy, Suspense, useState } from "react";
import { Globe, MessageSquareShare, Repeat, ShieldAlert, Upload, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ScenarioItem, ScenarioRequirement } from "@agent/shared";

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
