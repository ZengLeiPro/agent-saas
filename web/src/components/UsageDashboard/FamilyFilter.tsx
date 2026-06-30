/**
 * 模型家族筛选器（一二级视图复用）
 *
 * 4 个 toggle：全部 / Claude / GPT / 其他
 * 'all' 仅是前端 UI 概念，发请求时传 undefined（后端 family 缺省即不过滤）。
 */
import { cn } from "@/lib/utils";
import type { ModelFamily } from "./types";

const FAMILY_OPTIONS: { value: ModelFamily | "all"; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "claude", label: "Claude" },
  { value: "gpt", label: "GPT" },
  { value: "other", label: "其他" },
];

interface Props {
  value: ModelFamily | "all";
  onChange: (v: ModelFamily | "all") => void;
}

export function FamilyFilter({ value, onChange }: Props) {
  return (
    <div className="inline-flex items-center rounded-md border bg-card p-0.5">
      {FAMILY_OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            "rounded px-3 py-1 text-xs font-medium transition-colors",
            value === opt.value
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
