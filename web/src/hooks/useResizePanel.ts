import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Drag-to-resize hook for a split panel layout.
 * Returns the right panel's width ratio (0–1) and a mouse-down handler for the divider.
 */
export function useResizePanel(
  /** Initial ratio of the right panel (0–1). Default 0.5 */
  initialRatio = 0.5,
  /** Minimum ratio for the right panel */
  minRatio = 0.25,
  /** Maximum ratio for the right panel */
  maxRatio = 0.75,
  /** When this key changes, ratio resets to initialRatio */
  resetKey?: string | null,
) {
  const [ratio, setRatio] = useState(initialRatio);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const prevResetKey = useRef(resetKey);

  // Reset ratio when resetKey changes (e.g. panel re-opened)
  if (resetKey !== prevResetKey.current) {
    prevResetKey.current = resetKey;
    if (ratio !== initialRatio) setRatio(initialRatio);
  }

  const onDividerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [],
  );

  const onDividerDoubleClick = useCallback(() => {
    setRatio(initialRatio);
  }, [initialRatio]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const newRightRatio = 1 - x / rect.width;
      setRatio(Math.min(maxRatio, Math.max(minRatio, newRightRatio)));
    };

    const onMouseUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [minRatio, maxRatio]);

  return { ratio, containerRef, onDividerMouseDown, onDividerDoubleClick } as const;
}
