export function ResizablePanelDivider({
  label,
  onMouseDown,
  onDoubleClick,
}: {
  label: string;
  onMouseDown: (event: React.MouseEvent) => void;
  onDoubleClick: () => void;
}) {
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      className="group relative flex w-0 shrink-0 cursor-col-resize items-center justify-center"
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
    >
      <div className="absolute inset-y-0 -left-1 -right-1 z-10" />
      <div className="pointer-events-none absolute inset-y-0 w-px bg-border transition-colors group-hover:w-[3px] group-hover:bg-primary/30" />
    </div>
  );
}
