import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type Tone = "indigo" | "fuchsia" | "cyan" | "emerald" | "amber" | "rose" | "slate";

const toneGradients: Record<Tone, string> = {
  indigo: "from-indigo-500/60 via-violet-500/40 to-sky-400/40",
  fuchsia: "from-fuchsia-500/60 via-pink-500/40 to-rose-400/40",
  cyan: "from-cyan-500/60 via-sky-500/40 to-blue-400/40",
  emerald: "from-emerald-500/60 via-teal-500/40 to-cyan-400/40",
  amber: "from-amber-500/60 via-orange-500/40 to-rose-400/40",
  rose: "from-rose-500/60 via-pink-500/40 to-fuchsia-400/40",
  slate: "from-slate-400/40 via-slate-500/30 to-slate-400/20",
};

const toneBadgeBg: Record<Tone, string> = {
  indigo: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-300",
  fuchsia: "bg-fuchsia-500/10 text-fuchsia-600 dark:text-fuchsia-300",
  cyan: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-300",
  emerald: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300",
  amber: "bg-amber-500/10 text-amber-600 dark:text-amber-300",
  rose: "bg-rose-500/10 text-rose-600 dark:text-rose-300",
  slate: "bg-slate-500/10 text-slate-600 dark:text-slate-300",
};

export function AuroraCard({
  tone = "slate",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative rounded-2xl bg-gradient-to-br p-px shadow-sm transition hover:shadow-md",
        toneGradients[tone],
        className,
      )}
    >
      <div className="relative h-full rounded-[calc(1rem-1px)] bg-card p-4">{children}</div>
    </div>
  );
}

export function ToneBadge({
  tone = "slate",
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
        "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
        toneBadgeBg[tone],
        className,
      )}
    >
      <Icon className="h-4 w-4" />
    </span>
  );
}
