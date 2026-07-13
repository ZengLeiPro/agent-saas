import { Building2, MessageSquareText } from "lucide-react";
import type { OrgAgentSummary } from "@agent/shared";

export function ExpertWelcome({
  expert,
  onPrefill,
}: {
  expert: OrgAgentSummary;
  onPrefill: (prompt: string) => void;
}) {
  const prompts = expert.starterPrompts.length > 0
    ? expert.starterPrompts
    : ["你能帮我做什么？"];

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col items-center px-4 py-10 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-50 text-3xl shadow-sm dark:bg-brand-900/35" aria-hidden="true">
        {expert.avatar || <Building2 className="h-8 w-8 text-brand-600" />}
      </div>
      <h2 className="mt-4 text-xl font-semibold text-foreground">{expert.name}</h2>
      <div className="mt-1 text-xs font-medium text-brand-600">企业专家</div>
      <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
        {expert.description || "这位企业专家由组织统一配置，可以在限定职责范围内协助你完成工作。"}
      </p>
      <div className="mt-6 grid w-full gap-2 sm:grid-cols-2">
        {prompts.map((prompt, index) => (
          <button
            key={`${index}:${prompt}`}
            type="button"
            className="flex items-start gap-2 rounded-xl border bg-card px-3 py-3 text-left text-sm transition-colors hover:border-brand-200 hover:bg-brand-50/50 dark:hover:bg-brand-900/20"
            onClick={() => onPrefill(prompt)}
          >
            <MessageSquareText className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
            <span>{prompt}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
