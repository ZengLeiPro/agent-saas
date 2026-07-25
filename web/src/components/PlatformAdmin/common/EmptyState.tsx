import { type ComponentType, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface EmptyStateAction {
  label: string;
  onClick: () => void;
  icon?: ComponentType<{ className?: string }>;
}

/**
 * 统一空态：图标 + 标题 + 一句解释 + 主/次 CTA。
 *
 * 为什么要有 CTA 槽：改造前全模块 17 个空态里只有 1 个带按钮（SandboxesPage 的
 * 「返回列表」），其余是死文本。对内部运维影响有限，但客户面看到「暂无数据」会
 * 认为产品坏了，而不是「我该去建一个」。
 *
 * `tone="positive"` 用于「没有异常」这类**好消息**空态——它们不需要 CTA，
 * 也不该长得像故障（改造前 AttentionQueue / OverviewSection 已经这么做了，
 * 这里把它固化成一档，避免后续被误改成灰色的「暂无数据」）。
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  secondaryAction,
  tone = "default",
  compact = false,
  className,
  children,
}: {
  icon?: ComponentType<{ className?: string }>;
  title: ReactNode;
  description?: ReactNode;
  action?: EmptyStateAction;
  secondaryAction?: EmptyStateAction;
  tone?: "default" | "positive";
  /** 表格内联空态用 compact，减少纵向占位 */
  compact?: boolean;
  className?: string;
  /** 需要在空态里内嵌表单/示意图时使用（对齐 LangSmith「空态本身就是创建入口」） */
  children?: ReactNode;
}) {
  const ActionIcon = action?.icon;
  const SecondaryIcon = secondaryAction?.icon;
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 px-6 text-center",
        compact ? "py-8" : "py-12",
        className,
      )}
    >
      {Icon && (
        <Icon
          className={cn(
            "size-8",
            tone === "positive" ? "text-success" : "text-muted-foreground/60",
          )}
        />
      )}
      <div className={cn("text-sm font-medium", tone === "positive" ? "text-foreground" : "text-foreground")}>
        {title}
      </div>
      {description && (
        <p className="max-w-md text-xs leading-relaxed text-muted-foreground">{description}</p>
      )}
      {children}
      {(action || secondaryAction) && (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {action && (
            <Button type="button" size="sm" onClick={action.onClick}>
              {ActionIcon && <ActionIcon className="mr-1 size-3.5" />}
              {action.label}
            </Button>
          )}
          {secondaryAction && (
            <Button type="button" variant="outline" size="sm" onClick={secondaryAction.onClick}>
              {SecondaryIcon && <SecondaryIcon className="mr-1 size-3.5" />}
              {secondaryAction.label}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
