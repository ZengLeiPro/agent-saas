export interface HistoryAnchor {
  semanticId: string;
  offset: number;
  previousSemanticId?: string;
  nextSemanticId?: string;
}

export interface HistoryLayoutSnapshot {
  semanticIds: readonly string[];
  offsets: readonly number[];
}

export interface HistoryAnchorRestore {
  semanticId: string;
  scrollOffset: number;
  fallback: 'exact' | 'previous' | 'next';
}

function rowAtOffset(offsets: readonly number[], viewportOffset: number): number {
  if (offsets.length <= 1) return 0;
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((offsets[middle] ?? 0) <= viewportOffset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** Capture first visible semantic id + pixel offset, with deterministic adjacent fallbacks. */
export function captureHistoryAnchor(
  layout: HistoryLayoutSnapshot,
  viewportOffset: number,
): HistoryAnchor | undefined {
  if (layout.semanticIds.length === 0 || layout.offsets.length !== layout.semanticIds.length) return undefined;
  const index = rowAtOffset(layout.offsets, viewportOffset);
  const semanticId = layout.semanticIds[index];
  if (!semanticId) return undefined;
  return {
    semanticId,
    offset: (layout.offsets[index] ?? 0) - viewportOffset,
    ...(index > 0 ? { previousSemanticId: layout.semanticIds[index - 1] } : {}),
    ...(index + 1 < layout.semanticIds.length ? { nextSemanticId: layout.semanticIds[index + 1] } : {}),
  };
}

/**
 * Restore after prepend, image remeasure or BusinessStep expansion. Missing anchors use the
 * nearest captured adjacent semantic row; never fall through to scroll-to-bottom.
 */
export function restoreHistoryAnchor(
  anchor: HistoryAnchor,
  layout: HistoryLayoutSnapshot,
): HistoryAnchorRestore | undefined {
  if (layout.offsets.length !== layout.semanticIds.length) return undefined;
  const candidates = [
    [anchor.semanticId, 'exact'],
    [anchor.previousSemanticId, 'previous'],
    [anchor.nextSemanticId, 'next'],
  ] as const;
  for (const [semanticId, fallback] of candidates) {
    if (!semanticId) continue;
    const index = layout.semanticIds.indexOf(semanticId);
    if (index < 0) continue;
    return {
      semanticId,
      scrollOffset: Math.max(0, (layout.offsets[index] ?? 0) - anchor.offset),
      fallback,
    };
  }
  return undefined;
}
