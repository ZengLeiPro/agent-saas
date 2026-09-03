import { useLayoutEffect, useRef, useState } from 'react';

export const DESKTOP_PRIMARY_MIN_WIDTH = 640;
export const DESKTOP_LAYOUT_HYSTERESIS = 48;

const OUTER_GAP = 10;
const PANEL_DIVIDER_WIDTH = 10;
const PANEL_MIN_REM = 26;
const PANEL_MAX_REM = 46;

export type DesktopLayoutProtectionLevel = 0 | 1 | 2 | 3;

interface DesktopLayoutBudgetInput {
  containerWidth: number;
  fullSidebarWidth: number;
  compactSidebarWidth: number;
  hasSecondarySidebar: boolean;
  panelOpen: boolean;
  panelRatio: number;
  rootFontSize: number;
  sidebarPersistentlyCollapsed: boolean;
}

function clampPanelWidth(availableWidth: number, ratio: number, rootFontSize: number) {
  return Math.min(
    PANEL_MAX_REM * rootFontSize,
    Math.max(PANEL_MIN_REM * rootFontSize, availableWidth * ratio),
  );
}

export function getDesktopPrimaryWidth(
  input: DesktopLayoutBudgetInput,
  level: DesktopLayoutProtectionLevel,
) {
  const sidebarWidth = input.sidebarPersistentlyCollapsed
    ? 0
    : level === 0
      ? input.fullSidebarWidth
      : level < 3
        ? input.compactSidebarWidth
        : 0;
  const availableWidth = Math.max(
    0,
    input.containerWidth - sidebarWidth - OUTER_GAP - (sidebarWidth === 0 ? OUTER_GAP : 0),
  );
  const panelDocked = input.panelOpen && level < 2;
  if (!panelDocked) return availableWidth;
  return (
    availableWidth -
    clampPanelWidth(availableWidth, input.panelRatio, input.rootFontSize) -
    PANEL_DIVIDER_WIDTH
  );
}

export function resolveDesktopLayoutProtectionLevel(
  input: DesktopLayoutBudgetInput,
  previousLevel: DesktopLayoutProtectionLevel,
): DesktopLayoutProtectionLevel {
  if (input.containerWidth <= 0) return 0;

  const levels: DesktopLayoutProtectionLevel[] = [0];
  if (
    !input.sidebarPersistentlyCollapsed &&
    input.hasSecondarySidebar &&
    input.fullSidebarWidth > input.compactSidebarWidth
  )
    levels.push(1);
  if (input.panelOpen) levels.push(2);
  levels.push(3);

  const requiredLevel =
    levels.find((level) => getDesktopPrimaryWidth(input, level) >= DESKTOP_PRIMARY_MIN_WIDTH) ?? 3;
  if (requiredLevel >= previousLevel) return requiredLevel;

  const restoreThreshold = DESKTOP_PRIMARY_MIN_WIDTH + DESKTOP_LAYOUT_HYSTERESIS;
  return (
    levels.find(
      (level) => level < previousLevel && getDesktopPrimaryWidth(input, level) >= restoreThreshold,
    ) ?? previousLevel
  );
}

interface UseDesktopLayoutProtectionOptions {
  enabled: boolean;
  sidebarLayout: 'double' | 'single';
  sidebarPersistentlyCollapsed: boolean;
  panelOpen: boolean;
  panelRatio: number;
}

interface SidebarMetrics {
  layout: 'double' | 'single' | null;
  containerWidth: number;
  fullWidth: number;
  compactWidth: number;
  hasSecondary: boolean;
  rootFontSize: number;
}

const INITIAL_METRICS: SidebarMetrics = {
  layout: null,
  containerWidth: 0,
  fullWidth: 0,
  compactWidth: 0,
  hasSecondary: false,
  rootFontSize: 16,
};

export function useDesktopLayoutProtection({
  enabled,
  sidebarLayout,
  sidebarPersistentlyCollapsed,
  panelOpen,
  panelRatio,
}: UseDesktopLayoutProtectionOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fontProbeRef = useRef<HTMLSpanElement>(null);
  const [level, setLevel] = useState<DesktopLayoutProtectionLevel>(0);
  const levelRef = useRef<DesktopLayoutProtectionLevel>(level);
  const [metrics, setMetrics] = useState<SidebarMetrics>(INITIAL_METRICS);
  levelRef.current = level;

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const readMetrics = () => {
      const sidebar = container.firstElementChild as HTMLElement | null;
      const sidebarWidth = sidebar?.getBoundingClientRect().width ?? 0;
      const mainPanel = sidebar?.querySelector<HTMLElement>(
        '[data-testid=desktop-sidebar-main-panel]',
      );
      const mainPanelWidth = mainPanel?.getBoundingClientRect().width ?? sidebarWidth;
      const containerWidth = container.getBoundingClientRect().width;
      const fontProbeWidth = fontProbeRef.current?.getBoundingClientRect().width ?? 0;
      const rootFontSize =
        fontProbeWidth ||
        Number.parseFloat(getComputedStyle(document.documentElement).fontSize) ||
        16;

      setMetrics((current) => {
        let fullWidth = current.fullWidth;
        let compactWidth = current.compactWidth;
        let hasSecondary = current.hasSecondary;

        if (sidebarPersistentlyCollapsed) {
          fullWidth = 0;
          compactWidth = 0;
          hasSecondary = false;
        } else if (sidebarWidth > 0) {
          const rememberedSecondaryWidth = Math.max(0, fullWidth - compactWidth);
          compactWidth = mainPanelWidth;
          if (sidebarLayout === 'single' || levelRef.current === 0) {
            fullWidth = sidebarWidth;
            hasSecondary = sidebarLayout === 'double' && sidebarWidth > mainPanelWidth + 1;
          } else {
            fullWidth = mainPanelWidth + rememberedSecondaryWidth;
          }
        }

        const next = {
          layout: sidebarLayout,
          containerWidth,
          fullWidth,
          compactWidth,
          hasSecondary,
          rootFontSize,
        };
        if (
          current.layout === next.layout &&
          current.containerWidth === next.containerWidth &&
          current.fullWidth === next.fullWidth &&
          current.compactWidth === next.compactWidth &&
          current.hasSecondary === next.hasSecondary &&
          current.rootFontSize === next.rootFontSize
        )
          return current;
        return next;
      });
    };

    readMetrics();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', readMetrics);
      return () => window.removeEventListener('resize', readMetrics);
    }

    const observer = new ResizeObserver(readMetrics);
    observer.observe(container);
    const sidebar = container.firstElementChild;
    if (sidebar) observer.observe(sidebar);
    const mainPanel = sidebar?.querySelector('[data-testid=desktop-sidebar-main-panel]');
    if (mainPanel) observer.observe(mainPanel);
    if (fontProbeRef.current) observer.observe(fontProbeRef.current);
    return () => observer.disconnect();
  }, [enabled, sidebarLayout, sidebarPersistentlyCollapsed]);

  useLayoutEffect(() => {
    if (!enabled || metrics.layout !== sidebarLayout) {
      setLevel(0);
      return;
    }
    setLevel((current) =>
      resolveDesktopLayoutProtectionLevel(
        {
          containerWidth: metrics.containerWidth,
          fullSidebarWidth: metrics.fullWidth,
          compactSidebarWidth: metrics.compactWidth,
          hasSecondarySidebar: metrics.hasSecondary,
          panelOpen,
          panelRatio,
          rootFontSize: metrics.rootFontSize,
          sidebarPersistentlyCollapsed,
        },
        current,
      ),
    );
  }, [enabled, metrics, panelOpen, panelRatio, sidebarLayout, sidebarPersistentlyCollapsed]);

  const effectiveLevel = enabled && metrics.layout === sidebarLayout ? level : 0;
  return {
    containerRef,
    fontProbeRef,
    hideSecondarySidebar: effectiveLevel >= 1,
    overlayPanel: panelOpen && effectiveLevel >= 2,
    hideSidebar: !sidebarPersistentlyCollapsed && effectiveLevel >= 3,
  } as const;
}
