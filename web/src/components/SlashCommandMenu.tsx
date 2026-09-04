import { cn } from '@/lib/utils';
import type { SlashCommandDefinition } from '@/lib/slashCommandRegistry';

export default function SlashCommandMenu({ commands, selection, onSelect }: {
  commands: readonly SlashCommandDefinition[];
  selection: number;
  onSelect: (index: number) => void;
}) {
  return (
    <div role="listbox" aria-label="Slash 命令" className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-xl border bg-popover shadow-xl">
      {commands.map((command, index) => (
        <button
          key={command.name}
          type="button"
          role="option"
          aria-selected={index === selection}
          className={cn(
            'block w-full px-3 py-2 text-left transition-colors',
            index === selection ? 'bg-accent' : 'hover:bg-accent/60',
          )}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(index)}
        >
          <span className="flex items-center gap-2"><code className="font-semibold text-primary">{command.name}</code><span className="text-xs text-foreground">{command.summary}</span></span>
          <span className="mt-1 block truncate font-mono text-[11px] text-muted-foreground">{command.syntax}</span>
          <span className="mt-0.5 block text-[11px] text-muted-foreground">示例：{command.examples[0]} · {command.budgetHint}</span>
        </button>
      ))}
    </div>
  );
}
