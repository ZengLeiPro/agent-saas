import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

/** Accordion step shell — keeps all fields in one form (dirty-state safe); no multi-page wizard remount. */
export function OrgAgentFormStepSection({
  step,
  title,
  hint,
  open,
  onOpenChange,
  children,
  badge,
}: {
  step: string;
  title: string;
  hint?: string;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  children: ReactNode;
  badge?: string;
}) {
  const panelId = `org-agent-step-${step}`;
  return (
    <section className="overflow-hidden rounded-xl border">
      <button
        type="button"
        className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-muted/30"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => onOpenChange(!open)}
      >
        <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground">
          {step}
        </span>
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{title}</span>
            {badge ? (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                {badge}
              </span>
            ) : null}
          </span>
          {hint ? (
            <span className="block text-xs leading-5 text-muted-foreground">{hint}</span>
          ) : null}
        </span>
        <ChevronDown
          className={`mt-1 size-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-0' : '-rotate-90'}`}
        />
      </button>
      {open ? (
        <div id={panelId} className="space-y-4 border-t px-4 py-4">
          {children}
        </div>
      ) : null}
    </section>
  );
}
