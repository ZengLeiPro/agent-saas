import { describe, expect, it } from 'vitest';

import {
  getDesktopPrimaryWidth,
  resolveDesktopLayoutProtectionLevel,
  type DesktopLayoutProtectionLevel,
} from './useDesktopLayoutProtection';

function resolve(
  overrides: Partial<Parameters<typeof resolveDesktopLayoutProtectionLevel>[0]>,
  previousLevel: DesktopLayoutProtectionLevel = 0,
) {
  return resolveDesktopLayoutProtectionLevel(
    {
      containerWidth: 1920,
      fullSidebarWidth: 432,
      compactSidebarWidth: 160,
      hasSecondarySidebar: true,
      panelOpen: true,
      panelRatio: 0.35,
      rootFontSize: 16,
      sidebarPersistentlyCollapsed: false,
      ...overrides,
    },
    previousLevel,
  );
}

describe('桌面主内容宽度保护', () => {
  it('宽屏保留双栏侧边栏和停靠右栏', () => {
    expect(resolve({ containerWidth: 1920 })).toBe(0);
    expect(
      getDesktopPrimaryWidth(
        {
          containerWidth: 1920,
          fullSidebarWidth: 432,
          compactSidebarWidth: 160,
          hasSecondarySidebar: true,
          panelOpen: true,
          panelRatio: 0.35,
          rootFontSize: 16,
          sidebarPersistentlyCollapsed: false,
        },
        0,
      ),
    ).toBeGreaterThanOrEqual(640);
  });

  it('1366 宽度优先临时隐藏会话第二栏，保留用户刚打开的右栏', () => {
    expect(resolve({ containerWidth: 1366 })).toBe(1);
  });

  it('第二栏收起后仍不足时将右栏改为 overlay', () => {
    expect(resolve({ containerWidth: 1024 })).toBe(2);
  });

  it('没有右栏的极窄桌面布局最后临时隐藏左主栏', () => {
    expect(resolve({ containerWidth: 768, panelOpen: false })).toBe(3);
  });

  it('单栏被拖到最大且右栏打开时直接改为 overlay', () => {
    expect(
      resolve({
        containerWidth: 1440,
        fullSidebarWidth: 640,
        compactSidebarWidth: 640,
        hasSecondarySidebar: false,
      }),
    ).toBe(2);
  });

  it('按实际根字号换算右栏 rem 边界', () => {
    expect(resolve({ containerWidth: 1508, rootFontSize: 16 })).toBe(0);
    expect(resolve({ containerWidth: 1508, rootFontSize: 20 })).toBe(1);
  });

  it('恢复时保留 48px 滞回，跨过恢复线后才还原第二栏', () => {
    expect(resolve({ containerWidth: 1092, panelOpen: false }, 1)).toBe(1);
    expect(resolve({ containerWidth: 1130, panelOpen: false }, 1)).toBe(0);
  });

  it('用户主动折叠侧边栏时不再制造临时侧栏状态', () => {
    expect(
      resolve({
        containerWidth: 1024,
        fullSidebarWidth: 0,
        compactSidebarWidth: 0,
        hasSecondarySidebar: false,
        sidebarPersistentlyCollapsed: true,
      }),
    ).toBe(2);
  });
});
