/**
 * 跨会话消息泄漏回归（2026-08-01 线上）：
 * 会话 A 失败后，A 的「用户消息 + 失败提示」会跟着用户跑到新建会话草稿页 / 别的会话。
 * 根因是 newSession() 不作废在飞的详情请求，且 preserveTail 直接拿全局消息数组当基底。
 */
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

const authFetchMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/authFetch", () => ({ authFetch: authFetchMock }));
vi.mock("@/lib/preload", () => ({
  sessionsPreload: Promise.resolve({ sessions: [], hasMore: false }),
}));
vi.mock("@/lib/sessionListCache", () => ({
  loadSessionListCache: () => null,
  saveSessionListCache: vi.fn(),
}));
vi.mock("@/lib/messageCache", () => ({
  loadSessionMessageSnapshot: vi.fn().mockResolvedValue(null),
  saveSessionMessages: vi.fn(),
  clearSessionMessages: vi.fn().mockResolvedValue(undefined),
}));

import { useSession, type SessionCallbacks } from "./useSession";

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, statusText: "OK", json: async () => body } as unknown as Response;
}

/** 失败会话的详情：blocks 为空，靠 lastRunState 派生尾部 system-error */
const FAILED_DETAIL = {
  blocks: [],
  lastRunState: { status: "failed", error: "boom", runId: "run-a", finishedAt: null },
};

function makeCallbacks(): SessionCallbacks {
  return {
    resetMessages: vi.fn(),
    setMessages: vi.fn(),
    triggerScroll: vi.fn(),
    cancelActiveStream: vi.fn(),
  };
}

/** 让 session-a 的详情请求挂起，其余请求立即返回空 */
function mockPendingDetail(): { release: (body: unknown) => void; settled: Promise<Response> } {
  let release!: (value: Response) => void;
  const settled = new Promise<Response>((resolve) => { release = resolve; });
  authFetchMock.mockImplementation((url: string) => {
    if (url.startsWith("/api/sessions/session-a?") || url === "/api/sessions/session-a") return settled;
    if (url.startsWith("/api/chat/interactions/pending")) return Promise.resolve(jsonResponse([]));
    return Promise.resolve(jsonResponse({ sessions: [], hasMore: false }));
  });
  return { release: (body: unknown) => release(jsonResponse(body)), settled };
}

beforeEach(() => {
  authFetchMock.mockReset();
});

describe("useSession 跨会话详情请求隔离", () => {
  it("新建会话会作废在飞的详情请求，草稿页不会被旧会话消息占领", async () => {
    const { release, settled } = mockPendingDetail();
    const callbacks = makeCallbacks();
    const { result } = renderHook(() => useSession(callbacks));

    await act(async () => { result.current.selectSession("session-a"); });
    await act(async () => { result.current.newSession(); });
    await act(async () => { release(FAILED_DETAIL); await settled; });

    expect(callbacks.setMessages).not.toHaveBeenCalled();
    expect(result.current.sessionId).toBeNull();
  });

  it("对照：未被打断时详情返回会正常写入当前会话", async () => {
    const { release, settled } = mockPendingDetail();
    const callbacks = makeCallbacks();
    const { result } = renderHook(() => useSession(callbacks));

    await act(async () => { result.current.selectSession("session-a"); });
    await act(async () => { release(FAILED_DETAIL); await settled; });

    expect(callbacks.setMessages).toHaveBeenCalled();
    expect(result.current.sessionId).toBe("session-a");
  });
});
