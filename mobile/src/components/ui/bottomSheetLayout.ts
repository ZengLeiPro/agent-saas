export type BottomSheetSnap = 'auto' | 'half' | 'full';

/** The sheet surface reaches the bottom edge; safe-area padding belongs INSIDE it. */
export function bottomSheetLayout(screenHeight: number, topInset: number, bottomInset: number, snap: BottomSheetSnap) {
  const top = Math.max(0, topInset) + 8;
  const availableHeight = Math.max(0, screenHeight - top);
  const sizing = snap === 'full'
    ? { height: availableHeight }
    : snap === 'half'
      ? { height: Math.min(Math.round(screenHeight * 0.5), availableHeight) }
      : { maxHeight: Math.min(Math.round(screenHeight * 0.85), availableHeight) };
  return { sizing, paddingBottom: Math.max(8, bottomInset), fixedHeight: snap !== 'auto' };
}
