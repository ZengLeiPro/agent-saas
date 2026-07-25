/** 共用：时间范围选择器（一二级视图复用） */
import { useEffect, useRef, useState } from "react";
import { Calendar as CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Segmented, segmentedItemClass, type SegmentedOption } from "@/components/ui/segmented";
import type { RangePreset } from "./types";

export type RangeQuery = Exclude<RangePreset, "custom">;
export type RangeValue = RangeQuery | "custom";
export interface CustomRange {
  from: string; // YYYY-MM-DDTHH:mm
  to: string;
}

export const RANGE_OPTIONS: SegmentedOption<RangeQuery>[] = [
  { value: "today", label: "今日" },
  { value: "7d", label: "7 天" },
  { value: "30d", label: "30 天" },
  { value: "mtd", label: "本月" },
  { value: "all", label: "全部" },
];

interface Props {
  value: RangeValue;
  customRange: CustomRange | null;
  onChange: (value: RangeValue, custom?: CustomRange) => void;
  /** 右侧显示当前生效的日期范围（可选） */
  dateRangeLabel?: string;
}

function todayBeijing(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function nowBeijingMinute(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16);
}

function shiftDate(yyyyMmDd: string, deltaDays: number): string {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

function toDateTimeInputValue(value: string | undefined, fallback: string, isEnd = false): string {
  if (!value) return fallback;
  return value.includes("T") ? value : `${value}T${isEnd ? "23:59" : "00:00"}`;
}

function formatCustomLabel(range: CustomRange | null): string {
  if (!range) return "自定义";
  const from = range.from.replace("T", " ");
  const to = range.to.replace("T", " ");
  return `${from.slice(5)} ~ ${to.slice(5)}`;
}

export function RangeSelector({ value, customRange, onChange, dateRangeLabel }: Props) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const today = todayBeijing();
  const nowMinute = nowBeijingMinute();
  const defaultFrom = `${shiftDate(today, -29)}T00:00`;
  const [from, setFrom] = useState<string>(toDateTimeInputValue(customRange?.from, defaultFrom));
  const [to, setTo] = useState<string>(toDateTimeInputValue(customRange?.to, nowMinute, true));

  // 打开面板时用最新 customRange 重置编辑值
  useEffect(() => {
    if (open) {
      const t = todayBeijing();
      const n = nowBeijingMinute();
      setFrom(toDateTimeInputValue(customRange?.from, `${shiftDate(t, -29)}T00:00`));
      setTo(toDateTimeInputValue(customRange?.to, n, true));
    }
  }, [open, customRange]);

  // 点外面关闭
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const applyCustom = () => {
    if (!from || !to || from > to) return;
    onChange("custom", { from, to });
    setOpen(false);
  };

  const customLabel =
    value === "custom" && customRange
      ? formatCustomLabel(customRange)
      : "自定义";

  return (
    <div ref={wrapperRef} className="relative flex items-center gap-2">
      <Segmented
        ariaLabel="时间范围"
        options={RANGE_OPTIONS}
        // value 为 "custom" 时无预设选项命中，整枚胶囊里只有右侧自定义按钮高亮
        value={value as RangeQuery}
        onChange={(next) => {
          onChange(next);
          setOpen(false);
        }}
      >
        {/* 自定义区间是弹层触发器而非互斥选项，因此不进 ToggleGroup 的选项列表，
            只借 segmentedItemClass 保持外观一致 */}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={segmentedItemClass({ active: value === "custom" })}
          aria-expanded={open}
          title="自定义时间范围"
        >
          <CalendarIcon className="size-3" />
          <span className="tabular-nums">{customLabel}</span>
        </button>
      </Segmented>
      {dateRangeLabel && (
        <span className="text-xs text-muted-foreground tabular-nums">{dateRangeLabel}</span>
      )}

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 flex flex-wrap items-center gap-2 rounded-lg border bg-popover p-3 shadow-md">
          <div className="flex items-center gap-1.5">
            <label className="text-xs text-muted-foreground">从</label>
            <input
              type="datetime-local"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
              className="rounded-md border bg-background px-2 py-1 text-xs"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <label className="text-xs text-muted-foreground">到</label>
            <input
              type="datetime-local"
              value={to}
              min={from || undefined}
              max={nowMinute}
              onChange={(e) => setTo(e.target.value)}
              className="rounded-md border bg-background px-2 py-1 text-xs"
            />
          </div>
          <Button size="sm" onClick={applyCustom} disabled={!from || !to || from > to}>
            应用
          </Button>
        </div>
      )}
    </div>
  );
}
