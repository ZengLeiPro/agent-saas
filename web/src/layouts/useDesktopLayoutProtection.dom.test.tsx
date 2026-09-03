import { act, render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { useDesktopLayoutProtection } from './useDesktopLayoutProtection';

let resizeCallback: ResizeObserverCallback | null = null;

class ResizeObserverMock {
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback;
  }

  observe() {}
  unobserve() {}
  disconnect() {}
}

function Harness({
  enabled,
  sidebarWidth,
  nodeKey,
  containerWidth = 1600,
  fontProbeWidth = 16,
}: {
  enabled: boolean;
  sidebarWidth: number;
  nodeKey: string;
  containerWidth?: number;
  fontProbeWidth?: number;
}) {
  const protection = useDesktopLayoutProtection({
    enabled,
    sidebarLayout: 'double',
    sidebarPersistentlyCollapsed: false,
    panelOpen: true,
    panelRatio: 0.35,
  });
  const mode = protection.hideSidebar
    ? 'hidden'
    : protection.overlayPanel
      ? 'overlay'
      : protection.hideSecondarySidebar
        ? 'secondary-hidden'
        : 'normal';

  return (
    <div ref={protection.containerRef} data-layout-width={containerWidth}>
      <aside key={nodeKey} data-layout-width={sidebarWidth}>
        <div data-testid="desktop-sidebar-main-panel" data-layout-width="160" />
      </aside>
      <output data-testid="responsive-mode">{mode}</output>
      <span ref={protection.fontProbeRef} data-layout-width={fontProbeWidth} />
    </div>
  );
}

describe('桌面宽度保护 DOM 生命周期', () => {
  beforeAll(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getRect(
      this: HTMLElement,
    ) {
      const width = Number(this.getAttribute('data-layout-width') ?? 0);
      return {
        x: 0,
        y: 0,
        top: 0,
        right: width,
        bottom: 800,
        left: 0,
        width,
        height: 800,
        toJSON: () => undefined,
      } as DOMRect;
    });
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('设置模式往返后重新读取替换后的侧栏节点', () => {
    const view = render(<Harness enabled sidebarWidth={432} nodeKey="chat-before" />);
    expect(screen.getByTestId('responsive-mode').textContent).toBe('normal');

    view.rerender(<Harness enabled={false} sidebarWidth={280} nodeKey="settings" />);
    view.rerender(<Harness enabled sidebarWidth={760} nodeKey="chat-after" />);

    expect(screen.getByTestId('responsive-mode').textContent).toBe('secondary-hidden');
  });

  it('根字号运行时变化通过 1rem 探针触发重新预算', () => {
    const view = render(
      <Harness enabled sidebarWidth={432} nodeKey="chat" containerWidth={1508} />,
    );
    expect(screen.getByTestId('responsive-mode').textContent).toBe('normal');

    view.rerender(
      <Harness
        enabled
        sidebarWidth={432}
        nodeKey="chat"
        containerWidth={1508}
        fontProbeWidth={20}
      />,
    );
    act(() => resizeCallback?.([], {} as ResizeObserver));

    expect(screen.getByTestId('responsive-mode').textContent).toBe('secondary-hidden');
  });
});
