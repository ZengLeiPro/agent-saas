let offset = 0;

/** Process-local navigation anchor; session detail switches must not reset list position. */
export function captureSessionListAnchor(nextOffset: number): void {
  if (Number.isFinite(nextOffset) && nextOffset >= 0) offset = nextOffset;
}

export function readSessionListAnchor(): number {
  return offset;
}

export function resetSessionListAnchor(): void {
  offset = 0;
}
