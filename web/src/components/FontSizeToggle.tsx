import { cn } from '@/lib/utils';

interface FontSizeToggleProps {
  isLarge: boolean;
  onChange: (large: boolean) => void;
}

export function FontSizeToggle({ isLarge, onChange }: FontSizeToggleProps) {
  return (
    <div className="flex items-center overflow-hidden rounded-md border text-xs">
      <button
        type="button"
        className={cn(
          'px-1.5 py-0.5 transition-colors',
          !isLarge
            ? 'bg-foreground/10 font-medium text-foreground'
            : 'text-muted-foreground hover:text-foreground',
        )}
        onClick={() => onChange(false)}
        title="小字体 (14px)"
        aria-pressed={!isLarge}
      >
        小
      </button>
      <button
        type="button"
        className={cn(
          'px-1.5 py-0.5 transition-colors',
          isLarge
            ? 'bg-foreground/10 font-medium text-foreground'
            : 'text-muted-foreground hover:text-foreground',
        )}
        onClick={() => onChange(true)}
        title="大字体 (16px)"
        aria-pressed={isLarge}
      >
        大
      </button>
    </div>
  );
}
