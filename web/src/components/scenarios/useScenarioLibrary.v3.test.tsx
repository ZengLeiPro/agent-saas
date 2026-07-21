import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ScenarioLibraryResponse } from "@agent/shared";
import { useScenarioLibrary } from "./useScenarioLibrary";

const authFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/authFetch", () => ({ authFetch }));
vi.mock("./useRoleKitConfig", () => ({
  useRoleKitConfig: () => ({
    config: {
      roleKitV2Enabled: true,
      sanitizePreviewEnabled: true,
      firstDayGuideBar: { enabled: true, stageTimeoutMs: 1, showOnMobile: true },
      libraryVersion: "v3",
    },
    loading: false,
    reload: vi.fn(),
  }),
}));

describe("useScenarioLibrary V3", () => {
  it("V3 runtime parse 失败时显式标记 legacy-fallback，不伪装成 V3 成功", async () => {
    const legacy: ScenarioLibraryResponse = { roles: [], scenarios: [] };
    authFetch.mockImplementation(async (path: string) => ({
      ok: true,
      status: 200,
      json: async () => path.endsWith("/v3") ? { schemaVersion: 3, unexpected: true } : legacy,
    }));
    const { result } = renderHook(() => useScenarioLibrary());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.mode).toBe("legacy-fallback");
    expect(result.current.workflowLibrary).toBeNull();
    expect(result.current.library).toEqual(legacy);
    expect(result.current.fallbackReason).toBe("当前显示兼容目录");
    expect(result.current.fallbackReason).not.toMatch(/schema|校验|上游|response/i);
  });
});
