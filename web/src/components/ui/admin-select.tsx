/**
 * 后台密集界面用的下拉选择器。
 *
 * 存在理由：`ui/select.tsx`（Radix 封装，148 行）在 6 个分析模块里引用次数为 0，
 * 25 个下拉里 23 个是裸 `<select>` + 手写类串——高度、圆角、字号、背景色各写一版，
 * 暗色下有的用 `bg-background` 有的用 `bg-card`。这里把它收敛成一个受控组件。
 *
 * 相对裸 `<select>` 的实际收益（不只是"统一好看"）：
 *   1. 键盘：Radix 提供打字跳转、Home/End、Esc 关闭，且弹层在 Portal 里不被
 *      表格的 overflow 裁切（裸 select 的原生弹层在某些 WebView 里会被裁）
 *   2. 暗色：选项列表走 `bg-popover`，不再依赖浏览器原生渲染（Windows Chrome
 *      的原生 option 列表在暗色模式下仍是白底黑字）
 *   3. 空值：把 `value=""` 这个"全部/不限"的业务惯例统一处理掉，见下方 sentinel
 *
 * ⚠️ Radix Select 不允许 `<SelectItem value="">`（空串被它当作"清空"）。
 * 后台大量用 `""` 表示"全部/不限"，因此这里在边界处把 `""` 映射成 sentinel，
 * 对外仍然收发 `""`，调用点不需要知道这件事。
 */
import * as React from "react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** 内部占位值。用不可能与业务值冲突的字符串。 */
const EMPTY_SENTINEL = "__admin_select_empty__";

export type AdminSelectOption = {
  value: string;
  label: React.ReactNode;
  disabled?: boolean;
};

export type AdminSelectSize = "sm" | "md";

const TRIGGER_SIZE: Record<AdminSelectSize, string> = {
  /** 筛选栏：与 `Button size="sm"` / `Input className="h-8"` 同高 */
  sm: "h-8 px-2 text-xs",
  /** 表单：与 `Input` 默认同高 */
  md: "h-9 px-3 text-sm",
};

const ITEM_SIZE: Record<AdminSelectSize, string> = {
  sm: "py-1 pl-7 pr-2 text-xs",
  md: "py-1.5 pl-8 pr-2 text-sm",
};

export function AdminSelect({
  value,
  onValueChange,
  options,
  placeholder,
  size = "sm",
  className,
  contentClassName,
  disabled,
  ariaLabel,
}: {
  /** `""` 表示"全部/不限"，组件内部会转成 sentinel */
  value: string;
  onValueChange: (value: string) => void;
  options: readonly AdminSelectOption[];
  placeholder?: string;
  size?: AdminSelectSize;
  className?: string;
  contentClassName?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const encode = (raw: string) => (raw === "" ? EMPTY_SENTINEL : raw);
  const decode = (raw: string) => (raw === EMPTY_SENTINEL ? "" : raw);

  return (
    <Select
      value={encode(value)}
      onValueChange={(next) => onValueChange(decode(next))}
      disabled={disabled}
    >
      <SelectTrigger
        aria-label={ariaLabel}
        className={cn(
          "w-auto gap-1 bg-card shadow-none",
          TRIGGER_SIZE[size],
          className
        )}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className={cn("max-h-72", contentClassName)}>
        {options.map((option) => (
          <SelectItem
            key={option.value}
            value={encode(option.value)}
            disabled={option.disabled}
            className={ITEM_SIZE[size]}
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** 「全部」这类不限选项的通用构造器，避免每个调用点各写一遍 label。 */
export function allOption(label = "全部"): AdminSelectOption {
  return { value: "", label };
}
