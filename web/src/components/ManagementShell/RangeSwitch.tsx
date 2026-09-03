import { cn } from '@/lib/utils';

export type ManagementRange = '7d' | '30d' | '90d';

const ranges: readonly { value: ManagementRange; label: string }[] = [
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
  { value: '90d', label: '近 90 天' },
];

export function RangeSwitch({
  value,
  onChange,
}: {
  value: ManagementRange;
  onChange: (value: ManagementRange) => void;
}) {
  return (
    <div className="inline-flex rounded-xl bg-muted p-1" role="group" aria-label="统计时间范围">
      {ranges.map((range) => (
        <button
          key={range.value}
          type="button"
          className={cn(
            'rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors',
            value === range.value && 'bg-background text-primary shadow-sm',
          )}
          onClick={() => onChange(range.value)}
          aria-pressed={value === range.value}
        >
          {range.label}
        </button>
      ))}
    </div>
  );
}
