import { cn } from '@/lib/utils';

interface WidthToggleProps {
  isWide: boolean;
  onChange: (wide: boolean) => void;
}

export function WidthToggle({ isWide, onChange }: WidthToggleProps) {
  return (
    <div className="flex items-center overflow-hidden rounded-md border text-xs">
      <button
        type="button"
        className={cn(
          'px-1.5 py-0.5 transition-colors',
          !isWide
            ? 'bg-foreground/10 font-medium text-foreground'
            : 'text-muted-foreground hover:text-foreground',
        )}
        onClick={() => onChange(false)}
        title="窄版 (896px)"
      >
        窄
      </button>
      <button
        type="button"
        className={cn(
          'px-1.5 py-0.5 transition-colors',
          isWide
            ? 'bg-foreground/10 font-medium text-foreground'
            : 'text-muted-foreground hover:text-foreground',
        )}
        onClick={() => onChange(true)}
        title="宽版 (1152px)"
      >
        宽
      </button>
    </div>
  );
}
