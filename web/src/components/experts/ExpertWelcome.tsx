import { ChevronRight, MessageSquareText } from "lucide-react";
import type { OrgAgentSummary } from "@agent/shared";

export function ExpertWelcome({
  expert,
  onPrefill,
}: {
  expert: OrgAgentSummary;
  onPrefill: (prompt: string) => void;
}) {
  const prompts = (expert.starterPrompts.length > 0
    ? expert.starterPrompts
    : ["你能帮我做什么？"]
  ).slice(0, 3);

  return (
    <div className="content-container pt-4 sm:pt-5">
      <div className="mb-2 text-left text-[11px] font-medium tracking-wide text-muted-foreground">常用起手任务</div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {prompts.map((prompt, index) => (
          <button
            key={`${index}:${prompt}`}
            type="button"
            className="flex min-h-[56px] min-w-0 items-center gap-2.5 rounded-2xl border bg-card/70 px-3 py-2 text-left transition-[transform,border-color,background-color,box-shadow] hover:-translate-y-0.5 hover:border-brand-200 hover:bg-brand-50/35 hover:shadow-sm dark:hover:bg-brand-900/15"
            onClick={() => onPrefill(prompt)}
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-900/35">
              <MessageSquareText className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="line-clamp-2 text-xs font-semibold leading-4 text-foreground sm:text-sm">{prompt}</span>
              <span className="mt-0.5 block text-[11px] font-medium text-success-ink">直接试</span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground/45" />
          </button>
        ))}
      </div>
    </div>
  );
}
