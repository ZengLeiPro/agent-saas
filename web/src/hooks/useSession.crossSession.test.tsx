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
    expect(authFetchMock).toHaveBeenCalledWith(expect.stringContaining("limit=200"));
  });

  it("首屏只取尾部一页，并能向前合并历史且去除边界重叠", async () => {
    let currentMessages: ReturnType<NonNullable<SessionCallbacks["getMessages"]>> = [];
    const callbacks = makeCallbacks();
    callbacks.getMessages = () => currentMessages;
    callbacks.setMessages = vi.fn((messages) => { currentMessages = messages; });

    const blocks = (start: number, end: number) => Array.from(
      { length: end - start + 1 },
      (_, index) => {
        const line = start + index;
        return {
          id: `line-${line}`,
          kind: line % 2 === 0 ? "text" : "prompt",
          content: `内容 ${line}`,
        };
      },
    );
    authFetchMock.mockImplementation((url: string) => {
      if (url.includes("before=line-101")) {
        return Promise.resolve(jsonResponse({
          mode: "before",
          blocks: blocks(1, 101),
          oldestCursor: "line-1",
          cursor: "line-200",
          historyComplete: true,
        }));
      }
      if (url.startsWith("/api/sessions/session-a?")) {
        return Promise.resolve(jsonResponse({
          mode: "full",
          blocks: blocks(101, 200),
          oldestCursor: "line-101",
          cursor: "line-200",
          historyComplete: false,
        }));
      }
      if (url.startsWith("/api/chat/interactions/pending")) {
        return Promise.resolve(jsonResponse([]));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const { result } = renderHook(() => useSession(callbacks));
    await act(async () => { await result.current.loadSessionDetail("session-a"); });

    expect(currentMessages).toHaveLength(100);
    expect(currentMessages[0]?.id).toBe("line-101");
    expect(result.current.hasMoreHistory).toBe(true);

    await act(async () => { await result.current.loadEarlierMessages(); });

    expect(currentMessages).toHaveLength(200);
    expect(currentMessages[0]?.id).toBe("line-1");
    expect(currentMessages.at(-1)?.id).toBe("line-200");
    expect(currentMessages.filter((message) => message.id === "line-101")).toHaveLength(1);
    expect(result.current.hasMoreHistory).toBe(false);
    const beforeRequestCount = authFetchMock.mock.calls.filter(
      ([url]) => String(url).includes("before="),
    ).length;
    await act(async () => { await result.current.loadEarlierMessages(); });
    expect(authFetchMock.mock.calls.filter(([url]) => String(url).includes("before="))).toHaveLength(
      beforeRequestCount,
    );
  });

  it("并发点击历史页只发一个请求，失败后可以重试", async () => {
    let currentMessages: ReturnType<NonNullable<SessionCallbacks["getMessages"]>> = [];
    let beforeRequests = 0;
    const callbacks = makeCallbacks();
    callbacks.getMessages = () => currentMessages;
    callbacks.setMessages = vi.fn((messages) => { currentMessages = messages; });
    const tailBlocks = Array.from({ length: 100 }, (_, index) => ({
      id: `line-${index + 101}`,
      kind: "text",
      content: `尾页 ${index + 101}`,
    }));

    authFetchMock.mockImplementation((url: string) => {
      if (url.includes("before=")) {
        beforeRequests += 1;
        if (beforeRequests === 1) {
          return Promise.resolve({ ok: false, status: 500, statusText: "boom" } as Response);
        }
        return Promise.resolve(jsonResponse({
          mode: "before",
          blocks: [{ id: "line-100", kind: "prompt", content: "更早" }],
          oldestCursor: "line-100",
          cursor: "line-200",
          historyComplete: true,
        }));
      }
      if (url.startsWith("/api/sessions/session-a?")) {
        return Promise.resolve(jsonResponse({
          mode: "full",
          blocks: tailBlocks,
          oldestCursor: "line-101",
          cursor: "line-200",
          historyComplete: false,
        }));
      }
      if (url.startsWith("/api/chat/interactions/pending")) return Promise.resolve(jsonResponse([]));
      return Promise.resolve(jsonResponse({}));
    });

    const { result } = renderHook(() => useSession(callbacks));
    await act(async () => { await result.current.loadSessionDetail("session-a"); });

    let first!: Promise<void>;
    act(() => {
      first = result.current.loadEarlierMessages();
      void result.current.loadEarlierMessages();
    });
    await act(async () => { await first; });
    expect(beforeRequests).toBe(1);
    expect(result.current.isLoadingEarlier).toBe(false);
    expect(currentMessages[0]?.id).toBe("line-101");

    await act(async () => { await result.current.loadEarlierMessages(); });
    expect(beforeRequests).toBe(2);
    expect(currentMessages[0]?.id).toBe("line-100");
    expect(result.current.hasMoreHistory).toBe(false);
  });

  it("A 会话的慢历史请求不会阻塞 B 会话加载更早消息", async () => {
    let currentMessages: ReturnType<NonNullable<SessionCallbacks["getMessages"]>> = [];
    let releaseSessionA!: (response: Response) => void;
    const pendingSessionA = new Promise<Response>((resolve) => {
      releaseSessionA = resolve;
    });
    const callbacks = makeCallbacks();
    callbacks.getMessages = () => currentMessages;
    callbacks.setMessages = vi.fn((messages) => { currentMessages = messages; });

    authFetchMock.mockImplementation((url: string) => {
      if (url.includes("before=a-tail")) return pendingSessionA;
      if (url.includes("before=b-tail")) {
        return Promise.resolve(jsonResponse({
          mode: "before",
          blocks: [{ id: "b-old", kind: "prompt", content: "B 更早" }],
          oldestCursor: "b-old",
          cursor: "b-tail",
          historyComplete: true,
        }));
      }
      if (url.startsWith("/api/sessions/session-a?")) {
        return Promise.resolve(jsonResponse({
          mode: "full",
          blocks: [{ id: "a-tail", kind: "text", content: "A 尾页" }],
          oldestCursor: "a-tail",
          cursor: "a-tail",
          historyComplete: false,
        }));
      }
      if (url.startsWith("/api/sessions/session-b?")) {
        return Promise.resolve(jsonResponse({
          mode: "full",
          blocks: [{ id: "b-tail", kind: "text", content: "B 尾页" }],
          oldestCursor: "b-tail",
          cursor: "b-tail",
          historyComplete: false,
        }));
      }
      if (url.startsWith("/api/chat/interactions/pending")) {
        return Promise.resolve(jsonResponse([]));
      }
      return Promise.resolve(jsonResponse({ sessions: [], hasMore: false }));
    });

    const { result } = renderHook(() => useSession(callbacks));
    await act(async () => { await result.current.loadSessionDetail("session-a"); });

    let sessionAEarlier!: Promise<void>;
    act(() => { sessionAEarlier = result.current.loadEarlierMessages(); });

    act(() => { result.current.selectSession("session-b"); });
    await act(async () => { await result.current.loadDetailPromiseRef.current; });
    await act(async () => { await result.current.loadEarlierMessages(); });

    expect(authFetchMock.mock.calls.some(([url]) => String(url).includes("before=a-tail"))).toBe(true);
    expect(authFetchMock.mock.calls.some(([url]) => String(url).includes("before=b-tail"))).toBe(true);
    expect(currentMessages.map((message) => message.id)).toEqual(["b-old", "b-tail"]);
    expect(result.current.isLoadingEarlier).toBe(false);

    await act(async () => {
      releaseSessionA(jsonResponse({
        mode: "before",
        blocks: [{ id: "a-old", kind: "prompt", content: "A 更早" }],
        oldestCursor: "a-old",
        cursor: "a-tail",
        historyComplete: true,
      }));
      await sessionAEarlier;
    });
    expect(currentMessages.map((message) => message.id)).toEqual(["b-old", "b-tail"]);
  });

  it("历史 cursor 失效返回 full 时重置旧窗口而不是继续 prepend", async () => {
    let currentMessages: ReturnType<NonNullable<SessionCallbacks["getMessages"]>> = [];
    const callbacks = makeCallbacks();
    callbacks.getMessages = () => currentMessages;
    callbacks.setMessages = vi.fn((messages) => { currentMessages = messages; });
    authFetchMock.mockImplementation((url: string) => {
      if (url.includes("before=")) {
        return Promise.resolve(jsonResponse({
          mode: "full",
          blocks: [{ id: "line-1", kind: "text", content: "compaction 后新尾页" }],
          oldestCursor: "opaque-new-oldest",
          cursor: "opaque-new-tail",
          historyComplete: true,
        }));
      }
      if (url.startsWith("/api/sessions/session-a?")) {
        return Promise.resolve(jsonResponse({
          mode: "full",
          blocks: [{ id: "line-101", kind: "text", content: "旧尾页" }],
          oldestCursor: "opaque-old-oldest",
          cursor: "opaque-old-tail",
          historyComplete: false,
        }));
      }
      if (url.startsWith("/api/chat/interactions/pending")) return Promise.resolve(jsonResponse([]));
      return Promise.resolve(jsonResponse({}));
    });

    const { result } = renderHook(() => useSession(callbacks));
    await act(async () => { await result.current.loadSessionDetail("session-a"); });
    await act(async () => { await result.current.loadEarlierMessages(); });

    expect(currentMessages.map((message) => message.id)).toEqual(["line-1"]);
    expect(currentMessages[0]).toMatchObject({ content: "compaction 后新尾页" });
    expect(result.current.hasMoreHistory).toBe(false);
  });

  it("pending 失败不阻塞首屏消息", async () => {
    let currentMessages: ReturnType<NonNullable<SessionCallbacks["getMessages"]>> = [];
    const callbacks = makeCallbacks();
    callbacks.getMessages = () => currentMessages;
    callbacks.setMessages = vi.fn((messages) => { currentMessages = messages; });
    authFetchMock.mockImplementation((url: string) => {
      if (url.startsWith("/api/chat/interactions/pending")) {
        return Promise.reject(new Error("pending unavailable"));
      }
      if (url.startsWith("/api/sessions/session-a?")) {
        return Promise.resolve(jsonResponse({
          mode: "full",
          blocks: [{ id: "line-1", kind: "text", content: "首屏" }],
          oldestCursor: "line-1",
          cursor: "line-1",
          historyComplete: true,
        }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const { result } = renderHook(() => useSession(callbacks));
    await act(async () => {
      await result.current.loadSessionDetail("session-a");
      await Promise.resolve();
    });

    expect(currentMessages.map((message) => message.id)).toEqual(["line-1"]);
    expect(currentMessages.some((message) => message.id.startsWith("pending-"))).toBe(false);
  });

  it("历史页在途时保留新流式消息，慢 pending 随后合并到最新快照", async () => {
    let currentMessages: ReturnType<NonNullable<SessionCallbacks["getMessages"]>> = [];
    let releaseBefore!: (response: Response) => void;
    let releasePending!: (response: Response) => void;
    const beforeResponse = new Promise<Response>((resolve) => { releaseBefore = resolve; });
    const pendingResponse = new Promise<Response>((resolve) => { releasePending = resolve; });
    const callbacks = makeCallbacks();
    callbacks.getMessages = () => currentMessages;
    callbacks.setMessages = vi.fn((messages) => { currentMessages = messages; });

    authFetchMock.mockImplementation((url: string) => {
      if (url.includes("before=")) return beforeResponse;
      if (url.startsWith("/api/chat/interactions/pending")) return pendingResponse;
      if (url.startsWith("/api/sessions/session-a?")) {
        return Promise.resolve(jsonResponse({
          mode: "full",
          blocks: [{ id: "line-101", kind: "text", content: "尾页" }],
          oldestCursor: "line-101",
          cursor: "line-200",
          historyComplete: false,
        }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const { result } = renderHook(() => useSession(callbacks));
    await act(async () => { await result.current.loadSessionDetail("session-a"); });

    let earlier!: Promise<void>;
    act(() => { earlier = result.current.loadEarlierMessages(); });
    currentMessages = [
      ...currentMessages,
      { id: "stream-local", type: "text", content: "流式尾部" },
    ];
    await act(async () => {
      releaseBefore(jsonResponse({
        mode: "before",
        blocks: [{ id: "line-1", kind: "prompt", content: "历史" }],
        oldestCursor: "line-1",
        cursor: "line-200",
        historyComplete: true,
      }));
      await earlier;
    });
    expect(currentMessages.map((message) => message.id)).toEqual([
      "line-1",
      "line-101",
      "stream-local",
    ]);

    await act(async () => {
      releasePending(jsonResponse([{
        interactionId: "ask-1",
        type: "ask_user",
        questions: [{
          question: "继续吗？",
          header: "确认",
          options: [{ label: "继续", description: "继续执行" }],
          multiSelect: false,
        }],
      }]));
      await pendingResponse;
      await Promise.resolve();
    });
    expect(currentMessages.map((message) => message.id)).toEqual([
      "line-1",
      "line-101",
      "stream-local",
      "pending-runtime-waiting_user",
      "pending-ask-1",
    ]);
    expect(currentMessages[3]).toMatchObject({ type: "runtime_status", status: "waiting_user", content: "待补充" });
  });
});
