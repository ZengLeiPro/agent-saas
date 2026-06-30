import { useState, useCallback } from "react";
import { MessageCircleQuestion, Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface AskUserQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

interface AskUserBlockProps {
  questions: AskUserQuestion[];
  status: "pending" | "answered";
  answers?: Record<string, string>;
  onSubmit: (answers: Record<string, string>) => void;
}

function QuestionSection({
  q,
  qIndex,
  selected,
  customInputs,
  onToggle,
  onCustomChange,
  disabled,
}: {
  q: AskUserQuestion;
  qIndex: number;
  selected: Set<string>;
  customInputs: Record<number, string>;
  onToggle: (qIdx: number, label: string) => void;
  onCustomChange: (qIdx: number, value: string) => void;
  disabled: boolean;
}) {
  const isCustomSelected = selected.has("__custom__");

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="text-xs">{q.header}</Badge>
        <span className="text-sm">{q.question}</span>
        <span className="text-xs text-muted-foreground ml-auto">
          {q.multiSelect ? "多选" : "单选"}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {q.options.map((opt) => (
          <button
            key={opt.label}
            disabled={disabled}
            onClick={() => onToggle(qIndex, opt.label)}
            className={cn(
              "rounded-md border px-3 py-1.5 text-left transition-colors",
              selected.has(opt.label)
                ? "border-primary bg-primary/10 text-primary"
                : "border-border bg-background hover:border-primary/40 hover:bg-primary/5",
              disabled && "opacity-60 cursor-not-allowed",
            )}
          >
            <span className="text-xs font-medium">{opt.label}</span>
            {opt.description && (
              <span className="block text-[11px] leading-tight opacity-60 mt-0.5">{opt.description}</span>
            )}
          </button>
        ))}
        <button
          disabled={disabled}
          onClick={() => onToggle(qIndex, "__custom__")}
          className={cn(
            "rounded-md border px-3 py-1.5 text-xs transition-colors",
            isCustomSelected
              ? "border-primary bg-primary/10 text-primary"
              : "border-border bg-background hover:border-primary/40 hover:bg-primary/5",
            disabled && "opacity-60 cursor-not-allowed",
          )}
        >
          我自己写
        </button>
      </div>
      {isCustomSelected && (
        <Input
          placeholder="Enter your answer..."
          value={customInputs[qIndex] ?? ""}
          onChange={(e) => onCustomChange(qIndex, e.target.value)}
          disabled={disabled}
          className="text-sm"
        />
      )}
    </div>
  );
}

export function AskUserBlock({ questions, status, answers, onSubmit }: AskUserBlockProps) {
  const [selections, setSelections] = useState<Record<number, Set<string>>>({});
  const [customInputs, setCustomInputs] = useState<Record<number, string>>({});

  const handleToggle = useCallback((qIdx: number, label: string) => {
    setSelections((prev) => {
      const current = new Set(prev[qIdx] ?? []);
      const q = questions[qIdx];
      if (label === "__custom__") {
        if (current.has("__custom__")) {
          current.delete("__custom__");
        } else {
          if (!q.multiSelect) current.clear();
          current.add("__custom__");
        }
      } else {
        if (current.has(label)) {
          current.delete(label);
        } else {
          if (!q.multiSelect) {
            current.clear();
          }
          current.add(label);
        }
        current.delete("__custom__");
      }
      return { ...prev, [qIdx]: current };
    });
  }, [questions]);

  const handleCustomChange = useCallback((qIdx: number, value: string) => {
    setCustomInputs((prev) => ({ ...prev, [qIdx]: value }));
  }, []);

  const handleSubmit = useCallback(() => {
    const result: Record<string, string> = {};
    questions.forEach((q, i) => {
      const selected = selections[i] ?? new Set();
      if (selected.has("__custom__")) {
        result[q.question] = (customInputs[i] ?? "").trim();
      } else {
        const labels = Array.from(selected);
        result[q.question] = labels.join(", ");
      }
    });
    onSubmit(result);
  }, [questions, selections, customInputs, onSubmit]);

  const hasAnySelection = Object.entries(selections).some(([k, s]) => {
    if (s.size === 0) return false;
    if (s.has("__custom__") && s.size === 1) {
      return (customInputs[Number(k)] ?? "").trim().length > 0;
    }
    return true;
  });
  const isPending = status === "pending";

  return (
    <div className="border-b border-border/60 pb-2 mb-1">
      <div className="flex items-center gap-2 mb-2">
        <MessageCircleQuestion className="h-4 w-4 text-primary" />
        <span className="text-sm font-medium">Agent Question</span>
        {status === "answered" && (
          <Badge className="bg-success/10 text-success">Answered</Badge>
        )}
      </div>
      <div className="space-y-4">
        {isPending
          ? questions.map((q, i) => (
              <QuestionSection
                key={i}
                q={q}
                qIndex={i}
                selected={selections[i] ?? new Set()}
                customInputs={customInputs}
                onToggle={handleToggle}
                onCustomChange={handleCustomChange}
                disabled={false}
              />
            ))
          : questions.map((q, i) => (
              <div key={i} className="space-y-1">
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="text-xs">{q.header}</Badge>
                  <span className="text-sm">{q.question}</span>
                </div>
                <p className="text-sm text-muted-foreground pl-1">
                  {answers?.[q.question] ?? "(no answer)"}
                </p>
              </div>
            ))}
        {isPending && (
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={!hasAnySelection}
          >
            <Send className="mr-1 h-3.5 w-3.5" />
            Submit
          </Button>
        )}
      </div>
    </div>
  );
}
