import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      // 8 档。前 4 档是 shadcn 结构色（品牌 / 中性 / 破坏性动作 / 描边），
      // 后 4 档是状态语义色，一律走「15% 语义底 + text-*-ink」的浅底深字形态——
      // 后台徽章大量出现在表格单元格里，实心底会喧宾夺主。
      // 语义档的 -ink token 已内含亮/暗两套值，调用点不需要再写 dark: 变体。
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground hover:bg-primary/80",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80",
        outline: "text-foreground",
        /** 成功 / 完成 / 健康 */
        success: "border-transparent bg-success/15 text-success-ink",
        /** 等待 / 待处理 / 需要关注（等价于旧的 transient tone） */
        warning: "border-transparent bg-warning/15 text-warning-ink",
        /** 失败 / 异常（语义名，与 destructive 的"破坏性动作"含义区分） */
        danger: "border-transparent bg-danger/15 text-danger-ink",
        /** 运行中 / 持久态 / 中性提示 */
        info: "border-transparent bg-info/15 text-info-ink",
        /** 已取消 / 不适用 / 无数据 */
        muted: "border-transparent bg-muted text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof badgeVariants>) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
