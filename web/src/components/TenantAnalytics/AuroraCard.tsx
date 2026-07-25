import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * 客户面指标卡的语气。
 *
 * 改造前是七彩色板（indigo / fuchsia / cyan / emerald / amber / rose / slate），
 * 问题不是"不好看"，而是**同一个颜色承载两种含义**：`emerald` 既用在「成员数」
 * （纯装饰）又用在「完成率达标」（真的是好事），`fuchsia` 用在「对话轮次」上
 * 不表达任何东西。结果客户看到一片颜色，判断不出哪个需要他行动。
 *
 * 现在颜色预算全部给状态语义，只有四档：
 *   - good    确实是好状态，不需要动作
 *   - warn    需要留意（余额偏低、有成员没用起来）
 *   - bad     需要处理（余额告急、完成率不达标、有失败任务）
 *   - neutral 纯展示量，不承载好坏（成员数、对话轮次、任务总数）
 *
 * 判断依据：这个数字变化时，客户需不需要做什么。不需要就是 neutral。
 */
export type Tone = "good" | "warn" | "bad" | "neutral";

/**
 * 卡片描边。用语义 token 而非调色板值，暗色由 token 自身承担（不写 dark: 两段式）。
 * 强度刻意压低：描边是用来分组的，不该盖过卡内数字。
 */
const toneRing: Record<Tone, string> = {
  good: "bg-success/25",
  warn: "bg-warning/30",
  bad: "bg-danger/30",
  neutral: "bg-border",
};

const toneBadgeBg: Record<Tone, string> = {
  good: "bg-success-subtle text-success-ink",
  warn: "bg-warning-subtle text-warning-ink",
  bad: "bg-danger-subtle text-danger-ink",
  neutral: "bg-muted text-muted-foreground",
};

/**
 * 透传剩余 div props（role / tabIndex / onClick / onKeyDown / aria-*）。
 * 不透传的话「指标卡即入口」在客户面就是死的：`common/MetricCard` 的 aurora 变体
 * 把可交互属性传进来后会被静默丢掉，卡片看着能点、键盘完全到不了。
 */
export function AuroraCard({
  tone = "neutral",
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  tone?: Tone;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative rounded-2xl p-px shadow-sm transition hover:shadow-md",
        toneRing[tone],
        className,
      )}
      {...props}
    >
      <div className="relative h-full rounded-[calc(1rem-1px)] bg-card p-4">{children}</div>
    </div>
  );
}

export function ToneBadge({
  tone = "neutral",
  icon: Icon,
  className,
}: {
  tone?: Tone;
  icon: React.ComponentType<{ className?: string }>;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-lg",
        toneBadgeBg[tone],
        className,
      )}
    >
      <Icon className="size-4" />
    </span>
  );
}
