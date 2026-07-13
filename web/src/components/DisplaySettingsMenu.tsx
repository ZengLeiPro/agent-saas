import { useEffect, useRef, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FontSizeToggle } from "@/components/FontSizeToggle";
import { WidthToggle } from "@/components/WidthToggle";

interface DisplaySettingsMenuProps {
  isLarge: boolean;
  isWide: boolean;
  onFontSizeChange: (large: boolean) => void;
  onWidthChange: (wide: boolean) => void;
}

export function DisplaySettingsMenu({
  isLarge,
  isWide,
  onFontSizeChange,
  onWidthChange,
}: DisplaySettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const handleMouseDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative" onClick={(event) => event.stopPropagation()}>
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="icon"
        className={cn("h-8 w-8", open && "bg-accent text-accent-foreground")}
        onClick={() => setOpen((value) => !value)}
        title="显示设置"
        aria-label="显示设置"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <SlidersHorizontal className="h-5 w-5" />
      </Button>

      {open && (
        <div
          role="dialog"
          aria-label="显示设置"
          className="absolute right-0 top-full z-50 mt-2 w-56 rounded-xl border bg-popover p-3 text-popover-foreground shadow-xl"
        >
          <div className="mb-3 text-sm font-medium">显示设置</div>
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm text-muted-foreground">消息宽度</span>
              <WidthToggle isWide={isWide} onChange={onWidthChange} />
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm text-muted-foreground">字体大小</span>
              <FontSizeToggle isLarge={isLarge} onChange={onFontSizeChange} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
