/**
 * 分段控件（时间窗 / 视图切换 / 状态分组）。
 *
 * 改造前同一段 `rounded px-* py-1 text-xs font-medium transition-colors` + 三元 active
 * 在 7 处各写一遍，字号、内边距、hover 深度全部漂移。这里收敛成唯一实现。
 *
 * 基于 Radix ToggleGroup，白拿三样原生行为：`role="radiogroup"`、方向键在选项间
 * roving focus、选中态 `aria-checked`。手写 button 版本这三样一样都没有。
 *
 * 与 `ui/tabs.tsx` 的分工：Tabs 用于「切换整块内容区」（有 TabsContent），
 * Segmented 用于「筛选参数」——选中值只是一个 query 参数，不拥有内容区。
 */
import * as React from "react";
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";

import { cn } from "@/lib/utils";

export type SegmentedSize = "sm" | "default" | "lg";

export type SegmentedOption<T extends string | number> = {
  value: T;
  label: React.ReactNode;
  /** 原生 title，长标签截断时补全信息 */
  title?: string;
  disabled?: boolean;
};

/** 外壳：一枚描边胶囊，内部按钮共享 0.5 内边距 */
const SEGMENTED_SHELL = "inline-flex items-center rounded-md border bg-card p-0.5";

const SEGMENTED_ITEM_BASE =
  "inline-flex items-center gap-1 rounded py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

const SEGMENTED_ITEM_PADDING: Record<SegmentedSize, string> = {
  sm: "px-2.5",
  default: "px-3",
  lg: "px-4",
};

/**
 * 段落按钮类串。给「不是 ToggleGroupItem 但要长得一样」的元素用
 * （典型：RangeSelector 的自定义日期区间弹层触发器）。
 */
export function segmentedItemClass({
  active = false,
  size = "default",
  className,
}: { active?: boolean; size?: SegmentedSize; className?: string } = {}) {
  return cn(
    SEGMENTED_ITEM_BASE,
    SEGMENTED_ITEM_PADDING[size],
    active
      ? "bg-primary text-primary-foreground"
      : "text-muted-foreground hover:bg-accent hover:text-foreground",
    className
  );
}

export function Segmented<T extends string | number>({
  value,
  onChange,
  options,
  size = "default",
  className,
  itemClassName,
  ariaLabel,
  children,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  size?: SegmentedSize;
  className?: string;
  itemClassName?: string;
  ariaLabel?: string;
  /** 追加在选项之后、仍在同一枚胶囊内的自定义元素（如自定义时间区间触发器） */
  children?: React.ReactNode;
}) {
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      // Radix 只接受 string，数字 value 在边界处转换，回调时按 options 里的原类型还原
      value={String(value)}
      onValueChange={(next) => {
        // 分段控件必须恒有一个选中项。Radix 允许点已选项取消选中（next === ""），这里吞掉。
        if (!next) return;
        const hit = options.find((option) => String(option.value) === next);
        if (hit) onChange(hit.value);
      }}
      aria-label={ariaLabel}
      className={cn(SEGMENTED_SHELL, className)}
    >
      {options.map((option) => (
        <ToggleGroupPrimitive.Item
          key={String(option.value)}
          value={String(option.value)}
          title={option.title}
          disabled={option.disabled}
          className={cn(
            SEGMENTED_ITEM_BASE,
            SEGMENTED_ITEM_PADDING[size],
            // hover 只在未选中态生效，避免与选中态底色打架
            "text-muted-foreground data-[state=off]:hover:bg-accent data-[state=off]:hover:text-foreground",
            "data-[state=on]:bg-primary data-[state=on]:text-primary-foreground",
            itemClassName
          )}
        >
          {option.label}
        </ToggleGroupPrimitive.Item>
      ))}
      {children}
    </ToggleGroupPrimitive.Root>
  );
}
