import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ApiSessionListItem } from "@/lib/sessionsApi";

const fixtures = vi.hoisted(() => ({
  cacheSession: {
    sessionId: "cached-session",
    updatedAtMs: 100,
    source: { type: "web" as const, label: "WEB" },
  },
  freshSession: {
    sessionId: "running-session",
    updatedAtMs: 200,
    source: { type: "web" as const, label: "WEB" },
  },
}));

vi.mock("@/lib/preload", () => ({
  sessionsPreload: Promise.resolve({
    sessions: [fixtures.freshSession],
    hasMore: false,
  }),
}));

vi.mock("@/lib/sessionListCache", () => ({
  loadSessionListCache: () => ({
    sessions: [fixtures.cacheSession],
    hasMore: true,
  }),
  saveSessionListCache: vi.fn(),
}));

import { useSession, type SessionCallbacks } from "./useSession";

describe("useSession 首屏会话列表恢复", () => {
  it("缓存与预取列表加载后都会触发运行态恢复回调", async () => {
    const onSessionsLoaded = vi.fn();
    const callbacks: SessionCallbacks = {
      resetMessages: vi.fn(),
      setMessages: vi.fn(),
      triggerScroll: vi.fn(),
      cancelActiveStream: vi.fn(),
      onSessionsLoaded,
    };

    const { result } = renderHook(() => useSession(callbacks));

    await waitFor(() => {
      expect(onSessionsLoaded).toHaveBeenCalledTimes(2);
    });
    expect(onSessionsLoaded).toHaveBeenNthCalledWith(1, [fixtures.cacheSession]);
    expect(onSessionsLoaded).toHaveBeenNthCalledWith(2, [fixtures.freshSession]);
    expect(result.current.sessions).toEqual<ApiSessionListItem[]>([
      fixtures.freshSession,
    ]);
  });
});
