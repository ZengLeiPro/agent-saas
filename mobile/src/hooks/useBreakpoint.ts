import { useMemo } from 'react';
import { useWindowDimensions } from 'react-native';

/** Tailwind-aligned width breakpoints (logical px). */
export const BP = {
  sm: 640,
  md: 768,
  lg: 1024,
} as const;

export type BreakpointName = keyof typeof BP;

export type BreakpointState = {
  width: number;
  height: number;
  /** width ≥ 640 */
  isSmUp: boolean;
  /** width ≥ 768 — iPad / wide shell + chat master-detail */
  isMdUp: boolean;
  /** width ≥ 1024 */
  isLgUp: boolean;
};

/**
 * Window-width breakpoints for responsive shell / master-detail.
 * Drive layout by width (not `Platform.isPad`) so Split View and landscape stay correct.
 */
export function useBreakpoint(): BreakpointState {
  const { width, height } = useWindowDimensions();
  return useMemo(
    () => ({
      width,
      height,
      isSmUp: width >= BP.sm,
      isMdUp: width >= BP.md,
      isLgUp: width >= BP.lg,
    }),
    [width, height],
  );
}

/** Pure helper for tests and non-React callers. */
export function breakpointFromWidth(width: number): Omit<BreakpointState, 'width' | 'height'> {
  return {
    isSmUp: width >= BP.sm,
    isMdUp: width >= BP.md,
    isLgUp: width >= BP.lg,
  };
}
