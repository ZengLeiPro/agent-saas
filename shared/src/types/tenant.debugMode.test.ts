import { describe, expect, it } from "vitest";

import { isDebugModeAvailable, PLATFORM_TENANT_ID } from "./tenant";

describe("isDebugModeAvailable", () => {
  it("平台根组织也必须同时满足两级上级开关", () => {
    expect(isDebugModeAvailable(PLATFORM_TENANT_ID, undefined)).toBe(false);
    expect(isDebugModeAvailable(PLATFORM_TENANT_ID, {
      debugModeAllowed: true,
      debugModeEnabled: true,
    })).toBe(true);
  });

  it("平台未授权时始终关闭", () => {
    expect(isDebugModeAvailable("tenant-a", {
      debugModeAllowed: false,
      debugModeEnabled: true,
    })).toBe(false);
  });

  it("平台授权且组织开启时可用", () => {
    expect(isDebugModeAvailable("tenant-a", {
      debugModeAllowed: true,
      debugModeEnabled: true,
    })).toBe(true);
  });

  it("旧数据缺少组织开关时按关闭处理", () => {
    expect(isDebugModeAvailable("tenant-a", {
      debugModeAllowed: true,
    })).toBe(false);
  });
});
