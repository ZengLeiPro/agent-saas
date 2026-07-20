import { useCallback, useMemo, useState } from "react";
import { Check, ChevronLeft, ChevronRight, PenLine } from "lucide-react";
import { ActionIcons } from "@/lib/icons";

import { cn } from "@/lib/utils";
import type { AskUserAnswers } from "@agent/shared";
import type { AskUserQuestion } from "./AskUserBlock";

interface AskUserPromptPanelProps {
  questions: AskUserQuestion[];
  onSubmit: (answers: AskUserAnswers) => void;
}

const CUSTOM_VALUE = "__custom__";

function optionKey(qIndex: number, label: string) {
  return `${qIndex}:${label}`;
}

function ChoiceIndicator({ selected, multiSelect }: { selected: boolean; multiSelect: boolean }) {
  if (multiSelect) {
    return (
      <span
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded border transition-colors",
          selected
            ? "border-success bg-success text-success-foreground"
            : "border-muted-foreground/45 bg-background",
        )}
        aria-hidden
      >
        {selected && <Check className="size-3" strokeWidth={2.5} />}
      </span>
    );
  }

  return (
    <span
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
        selected ? "border-success" : "border-muted-foreground/45 bg-background",
      )}
      aria-hidden
    >
      {selected && <span className="size-2 rounded-full bg-success" />}
    </span>
  );
}

export function AskUserPromptPanel({ questions, onSubmit }: AskUserPromptPanelProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [selectedByQuestion, setSelectedByQuestion] = useState<Record<number, Set<string>>>({});
  const [customInputs, setCustomInputs] = useState<Record<number, string>>({});

  const question = questions[activeIndex];
  const total = questions.length;
  const selected = selectedByQuestion[activeIndex] ?? new Set<string>();
  const customSelected = selected.has(CUSTOM_VALUE);
  const customValue = (customInputs[activeIndex] ?? "").trim();

  const hasCurrentAnswer = useMemo(() => {
    if (!question) return false;
    if (customSelected) return customValue.length > 0;
    return selected.size > 0;
  }, [customSelected, customValue, question, selected]);

  const buildAnswers = useCallback((includeCurrent = true): AskUserAnswers => {
    const answers: AskUserAnswers = {};
    questions.forEach((q, index) => {
      if (!includeCurrent && index === activeIndex) return;
      const qSelected = selectedByQuestion[index] ?? new Set<string>();
      const labels = Array.from(qSelected).filter((label) => label !== CUSTOM_VALUE);
      const freeText = (customInputs[index] ?? "").trim();

      if (qSelected.has(CUSTOM_VALUE)) {
        if (q.multiSelect) {
          const values = freeText ? [...labels, freeText] : labels;
          if (values.length > 0) answers[q.question] = values;
        } else if (freeText) {
          answers[q.question] = freeText;
        }
        return;
      }

      if (q.multiSelect) {
        if (labels.length > 0) answers[q.question] = labels;
      } else if (labels[0]) {
        answers[q.question] = labels[0];
      }
    });
    return answers;
  }, [activeIndex, customInputs, questions, selectedByQuestion]);

  const submitAnswers = useCallback((answers: AskUserAnswers) => {
    onSubmit(answers);
  }, [onSubmit]);

  const goNextOrSubmit = useCallback((answers?: AskUserAnswers) => {
    if (activeIndex < total - 1) {
      setActiveIndex((idx) => Math.min(idx + 1, total - 1));
      return;
    }
    submitAnswers(answers ?? buildAnswers());
  }, [activeIndex, buildAnswers, submitAnswers, total]);

  const toggleOption = useCallback((label: string) => {
    if (!question) return;
    setSelectedByQuestion((prev) => {
      const current = new Set(prev[activeIndex] ?? []);
      if (question.multiSelect) {
        if (current.has(label)) current.delete(label);
        else current.add(label);
      } else {
        current.clear();
        current.add(label);
      }
      if (label !== CUSTOM_VALUE) current.delete(CUSTOM_VALUE);
      return { ...prev, [activeIndex]: current };
    });
  }, [activeIndex, question]);

  const handleOptionClick = useCallback((label: string) => {
    toggleOption(label);
  }, [toggleOption]);

  const handleCustomClick = useCallback(() => {
    if (!question) return;
    setSelectedByQuestion((prev) => {
      const current = new Set(prev[activeIndex] ?? []);
      if (!question.multiSelect) current.clear();
      if (current.has(CUSTOM_VALUE)) current.delete(CUSTOM_VALUE);
      else current.add(CUSTOM_VALUE);
      return { ...prev, [activeIndex]: current };
    });
  }, [activeIndex, question]);

  if (!question) return null;

  return (
    <div className="msg-user-text rounded-t-[1.75rem] rounded-b-none border-x border-t border-border/70 bg-card p-3 shadow-[0_8px_30px_-18px_rgba(15,23,42,0.35)] md:p-4">
      <div className="flex items-start gap-3 px-1 pb-3">
        <h3 className="min-w-0 flex-1 text-[inherit] font-semibold leading-[inherit] text-foreground">
          {question.question}
        </h3>
        <div className="flex shrink-0 items-center gap-2 text-[0.92em] text-muted-foreground">
          <button
            type="button"
            className="flex size-8 items-center justify-center rounded-full transition-colors hover:bg-muted"
            disabled={activeIndex === 0}
            onClick={() => setActiveIndex((idx) => Math.max(idx - 1, 0))}
            aria-label="上一题"
          >
            <ChevronLeft className="size-5" />
          </button>
          <span className="min-w-10 text-center tabular-nums text-foreground/80">
            {activeIndex + 1}/{total}
          </span>
          <button
            type="button"
            className="flex size-8 items-center justify-center rounded-full transition-colors hover:bg-muted"
            disabled={activeIndex === total - 1}
            onClick={() => setActiveIndex((idx) => Math.min(idx + 1, total - 1))}
            aria-label="下一题"
          >
            <ChevronRight className="size-5" />
          </button>
          <button
            type="button"
            className="flex size-8 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted"
            onClick={() => submitAnswers(buildAnswers(false))}
            aria-label="全部跳过"
            title="全部跳过"
          >
            <ActionIcons.skip className="size-5" />
          </button>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border/50">
        {question.options.map((option) => {
          const isSelected = selected.has(option.label);
          return (
            <button
              type="button"
              key={optionKey(activeIndex, option.label)}
              className={cn(
                "flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left transition-colors",
                "border-b border-border/50 last:border-b-0",
                "hover:bg-muted/50",
              )}
              onClick={() => handleOptionClick(option.label)}
            >
              <ChoiceIndicator selected={isSelected} multiSelect={question.multiSelect} />
              <span className="min-w-0 flex-1">
                <span className="block text-[inherit] leading-[inherit] text-foreground">{option.label}</span>
                {option.description && (
                  <span className="mt-0.5 block text-[0.92em] leading-[1.45] text-muted-foreground">{option.description}</span>
                )}
              </span>
            </button>
          );
        })}

        <div className="border-t border-border/50">
          <button
            type="button"
            className={cn(
              "flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left transition-colors",
              customSelected ? "bg-muted" : "hover:bg-muted/50",
            )}
            onClick={handleCustomClick}
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-background text-foreground shadow-sm">
              <PenLine className="size-4" />
            </span>
            <span className="text-[inherit] text-muted-foreground">其他补充...</span>
          </button>
          {customSelected && (
            <div className="px-3 pb-3">
              <textarea
                autoFocus
                autoComplete="off"
                value={customInputs[activeIndex] ?? ""}
                onChange={(event) => setCustomInputs((prev) => ({ ...prev, [activeIndex]: event.target.value }))}
                placeholder="补充你的回答..."
                rows={2}
                className="w-full resize-none rounded-xl border border-input bg-background px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-foreground/30 focus:ring-0"
              />
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 pt-3">
        <span className="rounded-full bg-[#FDF2E8] px-2 py-1 text-[0.82em] font-medium leading-none text-[#A0500E] dark:bg-[#E8843A]/20 dark:text-[#F5B078]">
          {question.multiSelect ? "可多选" : "单选"}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-full bg-muted px-4 py-2 text-[0.92em] font-medium text-foreground transition-colors hover:bg-muted/80"
            onClick={() => submitAnswers(buildAnswers(false))}
          >
            全部跳过
          </button>
          {(question.multiSelect || customSelected || total > 1 || hasCurrentAnswer) && (
            <button
              type="button"
              className="rounded-full bg-primary px-4 py-2 text-[0.92em] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
              disabled={!hasCurrentAnswer && activeIndex === total - 1}
              onClick={() => goNextOrSubmit()}
            >
              {activeIndex < total - 1 ? "下一题" : "提交"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
