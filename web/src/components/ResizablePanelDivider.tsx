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
      className="group relative h-full w-full shrink-0 cursor-col-resize select-none"
      onMouseDown={onMouseDown}
      onDoubleClick={onDoubleClick}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 h-12 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-transparent transition-[height,background-color,box-shadow] duration-150 group-hover:h-16 group-hover:bg-foreground/75 group-active:h-20 group-active:bg-foreground group-active:shadow-sm"
      />
    </div>
  );
}
