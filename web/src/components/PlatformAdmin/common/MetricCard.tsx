import { type ComponentType, type ReactNode } from "react";

import { AuroraCard, ToneBadge, type Tone as AuroraTone } from "@/components/TenantAnalytics/AuroraCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type MetricTone = "default" | "good" | "warn" | "bad";

function toneClassOf(tone: MetricTone): string {
  if (tone === "bad") return "text-destructive";
  if (tone === "warn") return "text-warning-ink";
  if (tone === "good") return "text-success-ink";
  return "";
}

/**
 * 全站唯一的指标卡。改造前有 5 套各自实现：
 * `common/MetricCard`（本文件）、`AdminShells` 本地 MetricCard、
 * `UsageDashboard/EfficiencyView` StatCard、`TenantAnalytics/OverviewSection` KpiCard、
 * `RunTraceExplorer/RunDetailView` StatItem（后者不是卡片，见文件末尾 MetricStat）。
 *
 * 以本文件为基准的理由：它是唯一带完整键盘可达性的实现
 * （`role="button"` + `tabIndex` + Enter/Space），「指标卡即入口」是我们的既有优势。
 *
 * **两种外观**：
 * - `variant="default"`：内部运维面（platform-admin / RunTraceExplorer），紧凑 Card。
 * - `variant="aurora"`：客户面（tenant-admin），走 AuroraCard 语义描边 + ToneBadge 图标。
 *   没有硬合成一种外观，因为客户面的观感是刻意设计的，硬合会让 tenant-admin 变成
 *   一片灰卡。注意 aurora 只是**外观**——「客户面不显示原始 ID / ¥$ 成本」这条约束
 *   由调用点传什么 value 决定，本组件不做也不该做脱敏。
 *
 * `auroraTone` 只有四档语义（good / warn / bad / neutral），默认 neutral：
 * 不传语气不代表「好」。见 `TenantAnalytics/AuroraCard.tsx` 的取舍说明。
 */
export function MetricCard({
  title,
  value,
  description,
  tone = "default",
  onClick,
  variant = "default",
  auroraTone = "neutral",
  icon: Icon,
  loading = false,
  descriptionClassName,
  valueClassName,
  className,
}: {
  title: ReactNode;
  value: ReactNode;
  description?: ReactNode;
  tone?: MetricTone;
  onClick?: () => void;
  variant?: "default" | "aurora";
  /** 仅 aurora 外观生效 */
  auroraTone?: AuroraTone;
  /** 仅 aurora 外观生效：右上角 ToneBadge 图标 */
  icon?: ComponentType<{ className?: string }>;
  /** 加载中：数值位显示「—」并压暗，卡片结构不塌 */
  loading?: boolean;
  descriptionClassName?: string;
  valueClassName?: string;
  className?: string;
}) {
  const interactive = Boolean(onClick);
  const interactiveProps = interactive
    ? {
      role: "button",
      tabIndex: 0,
      onClick,
      onKeyDown: (event: React.KeyboardEvent) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick?.();
        }
      },
    }
    : {};

  if (variant === "aurora") {
    return (
      <AuroraCard
        tone={auroraTone}
        className={cn(interactive && "cursor-pointer", className)}
        {...interactiveProps}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="text-xs font-medium text-muted-foreground">{title}</div>
            <div
              className={cn(
                "text-3xl font-semibold tracking-tight tabular-nums",
                loading && "text-muted-foreground/40",
                toneClassOf(tone),
                valueClassName,
              )}
            >
              {loading ? "—" : value}
            </div>
          </div>
          {Icon && <ToneBadge tone={auroraTone} icon={Icon} />}
        </div>
        {description && (
          <p className={cn("mt-2 text-xs text-muted-foreground", descriptionClassName)}>{description}</p>
        )}
      </AuroraCard>
    );
  }

  return (
    <Card
      density="compact"
      className={cn(interactive && "cursor-pointer transition-colors hover:bg-muted/50", className)}
      {...interactiveProps}
    >
      <CardHeader className="pb-1.5">
        <CardTitle className="text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div
          className={cn(
            "text-2xl font-semibold tabular-nums",
            loading && "text-muted-foreground/40",
            toneClassOf(tone),
            valueClassName,
          )}
        >
          {loading ? "—" : value}
        </div>
        {description && (
          <p className={cn("mt-1 text-xs text-muted-foreground", descriptionClassName)}>{description}</p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * 无卡片外壳的「标签 + 数值」对，用于密集网格（run 详情汇总头卡一行 6 个）。
 *
 * 刻意**不**把它并进 MetricCard：`RunDetailView` 的 11 项汇总放在一张卡的 6 列网格里，
 * 换成 11 张卡会把一屏信息拉成三屏——审计 Q2 点名的正是「信息密度过低」。
 * 归到本文件是为了让「指标展示」只有一个定义处（S7-3 的右侧 Stats 栏也会用它）。
 */
export function MetricStat({
  label,
  tone = "default",
  className,
  children,
}: {
  label: ReactNode;
  tone?: MetricTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="text-2xs text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 truncate text-sm font-medium", toneClassOf(tone))}>{children}</div>
    </div>
  );
}
