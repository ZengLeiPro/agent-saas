/**
 * Width-driven card grid columns for capability catalogs (experts / workflows / connectors).
 * Phone stays single-column; md+ becomes 2-up; lg+ 3-up.
 */
import { BP } from '../hooks/useBreakpoint';

export function cardGridColumns(width: number): number {
  if (width >= BP.lg) return 3;
  if (width >= BP.md) return 2;
  return 1;
}
