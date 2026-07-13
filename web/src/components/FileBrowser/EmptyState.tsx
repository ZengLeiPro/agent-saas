import { FolderOpen, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  /** 是否是「所有文件」视图 —— 文案略有不同 */
  variant?: "folder" | "all";
  className?: string;
}

/**
 * 空态：品牌蓝渐晕圆盘 + 图标 + 双行文案。
 * 参考 Linear / Notion 空态：不放插画，改用几何叠层制造视觉深度。
 */
export function EmptyState({ variant = "folder", className }: EmptyStateProps) {
  return (
    <div className={cn("flex flex-1 flex-col items-center justify-center gap-4 px-6 py-10 text-center", className)}>
      {/* 图标叠层：外圈品牌渐晕 + 内圈磨砂 tile */}
      <div className="relative">
        <div
          className={cn(
            "absolute inset-0 -m-4 rounded-full opacity-70 blur-xl",
            "bg-gradient-to-br from-brand-100 via-brand-50 to-transparent",
            "dark:from-brand-500/20 dark:via-brand-500/10 dark:to-transparent",
          )}
          aria-hidden
        />
        <div
          className={cn(
            "relative flex h-20 w-20 items-center justify-center rounded-2xl",
            "bg-gradient-to-br from-brand-50 to-brand-100/50",
            "ring-1 ring-inset ring-brand-200/60",
            "dark:from-brand-900/40 dark:to-brand-800/20 dark:ring-brand-700/40",
          )}
        >
          <FolderOpen className="h-10 w-10 text-brand-500 dark:text-brand-300" strokeWidth={1.5} />
          <Sparkles
            className={cn(
              "absolute -right-1 -top-1 h-5 w-5 text-brand-accent drop-shadow-sm",
              "dark:text-brand-accent",
            )}
          />
        </div>
      </div>

      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">
          {variant === "all" ? "还没有文件" : "文件夹是空的"}
        </p>
        <p className="max-w-[220px] text-xs leading-relaxed text-muted-foreground">
          让 AI 帮你生成报告、代码或数据，产物会自动出现在这里
        </p>
      </div>
    </div>
  );
}
