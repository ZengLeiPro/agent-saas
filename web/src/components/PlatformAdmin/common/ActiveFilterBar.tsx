import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ActiveFilterItem {
  /** React key，同时用于测试定位 */
  key: string;
  /** 人话化标签，形如「组织：开沿科技」——保持「字段名：值」可读形态 */
  label: string;
  onRemove: () => void;
}

/**
 * 生效中的筛选条件条。提取自 `RunTraceExplorer/RunListView.tsx` 已有的 FilterChip 实现。
 *
 * 刻意**不**改成对标产品那种 `status = failed AND tenant = xxx` 的 DSL 展示：
 * 审计确认我们的「组织：开沿科技」中文键值形态可读性更好，运维不需要学查询语法。
 * 本组件只做三件原本各页面各自重复的事：逐条删除、一键清除全部、条件为空时不占位。
 */
export function ActiveFilterBar({
  items,
  onClearAll,
  label = "筛选生效中",
  className,
}: {
  items: ActiveFilterItem[];
  /** 不传则不渲染「清除全部」 */
  onClearAll?: () => void;
  label?: string;
  className?: string;
}) {
  // 条件为空时整条不占位——不留一个空的 h-7 行把工具栏顶高
  if (items.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)} aria-label={label}>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {items.map((item) => (
        <FilterChip key={item.key} label={item.label} onRemove={item.onRemove} />
      ))}
      {onClearAll && (
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onClearAll}>
          清除全部
        </Button>
      )}
    </div>
  );
}

/** 单个筛选条件胶囊。导出供「不走 ActiveFilterBar 但要长得一样」的场景复用。 */
export function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="inline-flex h-7 items-center gap-1 rounded-full border border-primary/25 bg-primary/5 px-2.5 text-xs text-primary">
      {label}
      <button
        type="button"
        onClick={onRemove}
        className="rounded-full p-0.5 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        aria-label={`移除筛选：${label}`}
      >
        <X className="size-3" />
      </button>
    </span>
  );
}
