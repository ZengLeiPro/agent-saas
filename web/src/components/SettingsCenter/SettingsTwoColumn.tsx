import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SettingsTwoColumnProps {
  /** 左侧二级菜单/列表内容 */
  sidebar: ReactNode;
  /** 右侧主内容 */
  children: ReactNode;
  /** 左栏宽度（px），默认 220 */
  sidebarWidth?: number;
  /** 自定义类名（作用于最外层 grid 容器） */
  className?: string;
  /** 左栏额外类名 */
  sidebarClassName?: string;
  /** 右栏额外类名 */
  contentClassName?: string;
}

const DEFAULT_SIDEBAR_WIDTH = 220;

/**
 * 设置中心子面板「左二级菜单 + 右内容」两列布局的统一壳子。
 *
 * 约束（曾磊 2026-06-24 拍板）：
 * - md 断点（≥768）切两列，小屏堆叠；
 * - 左栏固定宽度（默认 220px），通过 CSS 变量传入，避免 Tailwind JIT 不识别动态拼接 class；
 * - 左右栏各自 min-h-0 + overflow-auto 独立滚动；
 * - 列间 gap-4，**无 border-l 竖线**，走简约美学；
 * - 不强加 Card 包装，由调用方在 sidebar/children 槽内自决。
 *
 * 调用方：ModelManager / CronManager（2026-06-24）。
 * TenantManager 是 list+detail（左栏是数据表格而非菜单），不复用此组件。
 */
export function SettingsTwoColumn({
  sidebar,
  children,
  sidebarWidth = DEFAULT_SIDEBAR_WIDTH,
  className,
  sidebarClassName,
  contentClassName,
}: SettingsTwoColumnProps) {
  return (
    <div
      className={cn(
        "grid gap-4 md:grid-cols-[var(--settings-sidebar-w)_minmax(0,1fr)]",
        className,
      )}
      style={
        {
          "--settings-sidebar-w": `${sidebarWidth}px`,
        } as CSSProperties
      }
    >
      <div
        className={cn(
          "min-w-0 space-y-4 md:min-h-0 md:overflow-auto",
          sidebarClassName,
        )}
      >
        {sidebar}
      </div>
      <div
        className={cn(
          "min-w-0 space-y-4 md:min-h-0 md:overflow-auto",
          contentClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}
