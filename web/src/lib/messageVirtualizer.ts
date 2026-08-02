export const DEFAULT_MESSAGE_ROW_HEIGHT = 160;
export const MESSAGE_ROW_GAP = 12;
export const MESSAGE_VIRTUAL_OVERSCAN = 600;
/** Hard cap for top-level message rows mounted at once. */
export const MAX_RENDERED_MESSAGE_ROWS = 80;

export interface MessageVirtualLayout {
  keys: readonly string[];
  offsets: readonly number[];
  sizes: readonly number[];
  totalSize: number;
  indexByKey: ReadonlyMap<string, number>;
}

export interface MessageVirtualRange {
  start: number;
  end: number;
}

export function buildMessageVirtualLayout(
  keys: readonly string[],
  measuredHeights: ReadonlyMap<string, number>,
  estimatedHeight = DEFAULT_MESSAGE_ROW_HEIGHT,
  gap = MESSAGE_ROW_GAP,
): MessageVirtualLayout {
  const offsets = new Array<number>(keys.length);
  const sizes = new Array<number>(keys.length);
  const indexByKey = new Map<string, number>();
  const fallbackSize = Math.max(1, estimatedHeight);
  const rowGap = Math.max(0, gap);
  let cursor = 0;

  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const measured = measuredHeights.get(key);
    const size = measured !== undefined && Number.isFinite(measured)
      ? Math.max(1, measured)
      : fallbackSize;
    offsets[index] = cursor;
    sizes[index] = size;
    indexByKey.set(key, index);
    cursor += size + rowGap;
  }

  return {
    keys,
    offsets,
    sizes,
    totalSize: keys.length > 0 ? cursor - rowGap : 0,
    indexByKey,
  };
}

/** Returns the first row whose bottom edge is after offset. */
export function findMessageRowAtOffset(layout: MessageVirtualLayout, offset: number): number {
  if (layout.keys.length === 0) return 0;
  const target = Math.max(0, offset);
  let low = 0;
  let high = layout.keys.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const bottom = layout.offsets[middle] + layout.sizes[middle];
    if (bottom <= target) low = middle + 1;
    else high = middle;
  }

  return Math.min(low, layout.keys.length - 1);
}

export function getMessageVirtualRange(
  layout: MessageVirtualLayout,
  viewportStart: number,
  viewportSize: number,
  overscan = MESSAGE_VIRTUAL_OVERSCAN,
  maxRows = MAX_RENDERED_MESSAGE_ROWS,
): MessageVirtualRange {
  const count = layout.keys.length;
  if (count === 0 || maxRows <= 0) return { start: 0, end: 0 };

  // Before the real container is measured (and in jsdom), render the complete small list.
  // For a long initial session, render the bounded tail so lastMessageRef exists and the
  // existing auto-scroll contract can place the viewport before the first scroll event.
  if (viewportSize <= 0) {
    const limit = Math.max(1, Math.floor(maxRows));
    return count <= limit
      ? { start: 0, end: count }
      : { start: count - limit, end: count };
  }

  const safeViewportStart = Math.max(0, viewportStart);
  const safeViewportSize = Math.max(0, viewportSize);
  const safeOverscan = Math.max(0, overscan);
  const visibleStart = findMessageRowAtOffset(layout, safeViewportStart);
  const visibleEndOffset = safeViewportStart + safeViewportSize;
  let visibleEnd = visibleStart + 1;
  while (visibleEnd < count && layout.offsets[visibleEnd] < visibleEndOffset) {
    visibleEnd += 1;
  }

  const overscanStart = findMessageRowAtOffset(layout, safeViewportStart - safeOverscan);
  const overscanEndOffset = visibleEndOffset + safeOverscan;
  let overscanEnd = visibleEnd;
  while (overscanEnd < count && layout.offsets[overscanEnd] < overscanEndOffset) {
    overscanEnd += 1;
  }

  const limit = Math.max(1, Math.floor(maxRows));
  if (overscanEnd - overscanStart <= limit) {
    return { start: overscanStart, end: overscanEnd };
  }

  // Keep every visible row when possible, then divide the remaining budget around it.
  const visibleCount = visibleEnd - visibleStart;
  if (visibleCount >= limit) {
    return { start: visibleStart, end: Math.min(count, visibleStart + limit) };
  }
  const remaining = limit - visibleCount;
  const before = Math.min(visibleStart - overscanStart, Math.floor(remaining / 2));
  let start = visibleStart - before;
  let end = Math.min(count, start + limit);
  start = Math.max(0, end - limit);
  return { start, end };
}

export function getMessageAnchorAdjustment(
  previous: MessageVirtualLayout,
  next: MessageVirtualLayout,
  anchorKey: string,
): number {
  const previousIndex = previous.indexByKey.get(anchorKey);
  const nextIndex = next.indexByKey.get(anchorKey);
  if (previousIndex === undefined || nextIndex === undefined) return 0;
  return next.offsets[nextIndex] - previous.offsets[previousIndex];
}
