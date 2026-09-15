import { describe, expect, it } from 'vitest';
import {
  DESKTOP_LAYOUT_HYSTERESIS,
  DESKTOP_PRIMARY_MIN_WIDTH,
  OVERLAY_MIN_WIDTH,
  clampOverlayForMainMinWidth,
  getPrimaryWidthWithMasterChrome,
  remainingMainWidth,
  resolveMasterChromeProtectionLevel,
  resolveProtectedOverlayWidth,
  shouldHideMasterChrome,
  withWidthHysteresis,
  type MasterChromeProtectionLevel,
} from './layoutProtection';

describe('clampOverlayForMainMinWidth', () => {
  it('keeps desired width when host can afford main ≥ 640', () => {
    const overlay = clampOverlayForMainMinWidth({
      hostWidth: 1180,
      desiredOverlayWidth: 380,
    });
    expect(overlay).toBe(380);
    expect(remainingMainWidth(1180, overlay)).toBeGreaterThanOrEqual(DESKTOP_PRIMARY_MIN_WIDTH);
  });

  it('shrinks overlay to protect the main floor when room ≥ min overlay', () => {
    // 1000 − 640 = 360 room; desired 380 → clamp to 360 so main stays 640
    const overlay = clampOverlayForMainMinWidth({
      hostWidth: 1000,
      desiredOverlayWidth: 380,
    });
    expect(overlay).toBe(360);
    expect(remainingMainWidth(1000, overlay)).toBe(DESKTOP_PRIMARY_MIN_WIDTH);
  });

  it('falls back to compact overlay when the main floor cannot be met', () => {
    // 768 − 640 = 128 < OVERLAY_MIN_WIDTH → compact ~45%
    const overlay = clampOverlayForMainMinWidth({
      hostWidth: 768,
      desiredOverlayWidth: 380,
    });
    expect(overlay).toBe(Math.min(380, Math.max(OVERLAY_MIN_WIDTH, Math.floor(768 * 0.45))));
    expect(remainingMainWidth(768, overlay)).toBeLessThan(DESKTOP_PRIMARY_MIN_WIDTH);
  });
});

describe('withWidthHysteresis', () => {
  it('activates immediately below threshold', () => {
    expect(withWidthHysteresis(639, DESKTOP_PRIMARY_MIN_WIDTH, false)).toBe(true);
  });

  it('restores only after threshold + 48px', () => {
    expect(withWidthHysteresis(640, DESKTOP_PRIMARY_MIN_WIDTH, true)).toBe(true);
    expect(
      withWidthHysteresis(
        DESKTOP_PRIMARY_MIN_WIDTH + DESKTOP_LAYOUT_HYSTERESIS - 1,
        DESKTOP_PRIMARY_MIN_WIDTH,
        true,
      ),
    ).toBe(true);
    expect(
      withWidthHysteresis(
        DESKTOP_PRIMARY_MIN_WIDTH + DESKTOP_LAYOUT_HYSTERESIS,
        DESKTOP_PRIMARY_MIN_WIDTH,
        true,
      ),
    ).toBe(false);
  });

  it('does not activate at the threshold when previously inactive', () => {
    expect(withWidthHysteresis(DESKTOP_PRIMARY_MIN_WIDTH, DESKTOP_PRIMARY_MIN_WIDTH, false)).toBe(
      false,
    );
  });
});

describe('resolveProtectedOverlayWidth', () => {
  it('uses desired width when main stays ≥ 640', () => {
    const next = resolveProtectedOverlayWidth({
      hostWidth: 1180,
      desiredOverlayWidth: 380,
      protectionActive: false,
    });
    expect(next.protectionActive).toBe(false);
    expect(next.width).toBe(380);
  });

  it('activates protection immediately when desired overlay would starve main', () => {
    // 1000 − 380 = 620 remaining-if-desired < 640 → protect; clamp to 360 so main stays 640
    const next = resolveProtectedOverlayWidth({
      hostWidth: 1000,
      desiredOverlayWidth: 380,
      protectionActive: false,
    });
    expect(next.protectionActive).toBe(true);
    expect(next.width).toBe(360);
  });

  it('keeps protection until remaining-if-desired clears 640+48', () => {
    const still = resolveProtectedOverlayWidth({
      hostWidth: 640 + 380 + 20,
      desiredOverlayWidth: 380,
      protectionActive: true,
    });
    expect(still.protectionActive).toBe(true);
    const restored = resolveProtectedOverlayWidth({
      hostWidth: 640 + 380 + 48,
      desiredOverlayWidth: 380,
      protectionActive: true,
    });
    expect(restored.protectionActive).toBe(false);
    expect(restored.width).toBe(380);
  });
});


function resolveMaster(
  overrides: Partial<Parameters<typeof resolveMasterChromeProtectionLevel>[0]>,
  previousLevel: MasterChromeProtectionLevel = 0,
) {
  return resolveMasterChromeProtectionLevel(
    {
      containerWidth: 1180,
      masterWidth: 360,
      overlayWidth: 0,
      sidebarPersistentlyCollapsed: false,
      ...overrides,
    },
    previousLevel,
  );
}

describe('resolveMasterChromeProtectionLevel', () => {
  it('keeps master visible when primary stays ≥ 640', () => {
    // 1180 − 360 = 820 ≥ 640
    expect(resolveMaster({})).toBe(0);
    expect(
      getPrimaryWidthWithMasterChrome(
        {
          containerWidth: 1180,
          masterWidth: 360,
          overlayWidth: 0,
          sidebarPersistentlyCollapsed: false,
        },
        0,
      ),
    ).toBeGreaterThanOrEqual(DESKTOP_PRIMARY_MIN_WIDTH);
  });

  it('hides master at md=768 so primary can reach ≥ 640', () => {
    // 768 − 360 = 408 < 640 → level 1; with master hidden primary = 768
    expect(resolveMaster({ containerWidth: 768 })).toBe(1);
    expect(
      getPrimaryWidthWithMasterChrome(
        {
          containerWidth: 768,
          masterWidth: 360,
          overlayWidth: 0,
          sidebarPersistentlyCollapsed: false,
        },
        1,
      ),
    ).toBe(768);
  });

  it('hides master when overlay would starve primary with master shown', () => {
    // 1024 − 360 − 380 = 284 < 640 → hide master → 1024 − 380 = 644 ≥ 640
    expect(resolveMaster({ containerWidth: 1024, overlayWidth: 380 })).toBe(1);
  });

  it('restores master only after primary clears 640+48 hysteresis', () => {
    // At level 1, need primary-with-master ≥ 688 to restore
    // 1000 − 360 = 640 → still hide
    expect(resolveMaster({ containerWidth: 1000 }, 1)).toBe(1);
    // 1048 − 360 = 688 → restore
    expect(
      resolveMaster(
        { containerWidth: DESKTOP_PRIMARY_MIN_WIDTH + 360 + DESKTOP_LAYOUT_HYSTERESIS },
        1,
      ),
    ).toBe(0);
  });

  it('does not invent temporary hide when user persistently collapsed', () => {
    expect(
      resolveMaster({
        containerWidth: 768,
        sidebarPersistentlyCollapsed: true,
      }),
    ).toBe(0);
  });
});

describe('shouldHideMasterChrome', () => {
  it('hides for persistent collapse or protection level 1', () => {
    expect(shouldHideMasterChrome({ protectionLevel: 0, sidebarPersistentlyCollapsed: false })).toBe(
      false,
    );
    expect(shouldHideMasterChrome({ protectionLevel: 1, sidebarPersistentlyCollapsed: false })).toBe(
      true,
    );
    expect(shouldHideMasterChrome({ protectionLevel: 0, sidebarPersistentlyCollapsed: true })).toBe(
      true,
    );
  });
});
