import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSessionMessages } from "@/lib/messageCache";
import { useSession, type SessionCallbacks } from "./useSession";

const authFetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/authFetch", () => ({ authFetch: authFetchMock }));
vi.mock("@/lib/preload", () => ({ sessionsPreload: Promise.resolve(null) }));
vi.mock("@/lib/sessionListCache", () => ({ loadSessionListCache: () => null, saveSessionListCache: vi.fn() }));
vi.mock("@/lib/messageCache", () => ({
  loadSessionMessageSnapshot: vi.fn().mockResolvedValue(null),
  saveSessionMessages: vi.fn(),
  clearSessionMessages: vi.fn().mockResolvedValue(undefined),
}));

const sessions = [{ sessionId: "session-a", updatedAtMs: 2 }, { sessionId: "session-b", updatedAtMs: 1 }];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function callbacks(): SessionCallbacks {
  return { resetMessages: vi.fn(), setMessages: vi.fn(), triggerScroll: vi.fn(), cancelActiveStream: vi.fn(), onNewSession: vi.fn() };
}
async function openSession() {
  const cb = callbacks();
  const hook = renderHook(() => useSession(cb));
  await waitFor(() => expect(hook.result.current.sessions).toHaveLength(2));
  await act(async () => { hook.result.current.selectSession("session-a"); await hook.result.current.loadDetailPromiseRef.current; });
  act(() => hook.result.current.confirmDeleteSession("session-a"));
  return { ...hook, cb };
}

beforeEach(() => {
  vi.mocked(clearSessionMessages).mockReset().mockResolvedValue(undefined);
  authFetchMock.mockReset().mockImplementation(async (url: string) => {
    if (url.startsWith("/api/sessions?")) return json({ sessions, hasMore: false });
    if (url.startsWith("/api/chat/interactions/pending")) return json([]);
    return json({ blocks: [] });
  });
  vi.spyOn(window, "alert").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe("会话删除交互", () => {
  it("服务端确认后立即回新建页，不等待缓存清理或刷新列表", async () => {
    const { result, cb } = await openSession();
    const cache = deferred<void>();
    vi.mocked(clearSessionMessages).mockReturnValueOnce(cache.promise);
    const deletion = deferred<Response>();
    authFetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return deletion.promise;
      throw new Error("删除不应触发列表刷新或加载其他会话");
    });
    let done = false;
    let pending!: Promise<void>;
    act(() => { pending = result.current.handleDeleteSession().then(() => { done = true; }); });
    expect(result.current.sessionId).toBe("session-a");
    await act(async () => { deletion.resolve(json({ ok: true })); });
    await waitFor(() => expect(done).toBe(true));
    expect(result.current.sessionId).toBeNull();
    expect(result.current.isNewSession).toBe(true);
    expect(result.current.deleteSessionId).toBeNull();
    expect(result.current.sessions.map((item) => item.sessionId)).toEqual(["session-b"]);
    expect(cb.onNewSession).toHaveBeenCalledOnce();
    expect(window.alert).not.toHaveBeenCalled();
    cache.resolve();
    await pending;
  });

  it("删除失败保留当前会话和确认框，允许重试", async () => {
    const { result, cb } = await openSession();
    authFetchMock.mockResolvedValue(json({ error: "失败" }, 500));
    await act(async () => { await result.current.handleDeleteSession(); });
    expect(result.current.sessionId).toBe("session-a");
    expect(result.current.sessions).toHaveLength(2);
    expect(result.current.deleteSessionId).toBe("session-a");
    expect(cb.onNewSession).not.toHaveBeenCalled();
    expect(window.alert).toHaveBeenCalledWith("删除失败");
    authFetchMock.mockResolvedValue(json({ ok: true }));
    await act(async () => { await result.current.handleDeleteSession(); });
    expect(result.current.sessionId).toBeNull();
  });

  it("删除等待期间切换到另一会话，成功回执不抢走新选择", async () => {
    const { result, cb } = await openSession();
    const deletion = deferred<Response>();
    const original = authFetchMock.getMockImplementation()!;
    authFetchMock.mockImplementation((url: string, init?: RequestInit) => init?.method === "DELETE" ? deletion.promise : original(url, init));
    let pending!: Promise<void>;
    act(() => { pending = result.current.handleDeleteSession(); });
    await act(async () => { result.current.selectSession("session-b"); await result.current.loadDetailPromiseRef.current; });
    await act(async () => { deletion.resolve(json({ ok: true })); await pending; });
    expect(result.current.sessionId).toBe("session-b");
    expect(cb.onNewSession).not.toHaveBeenCalled();
  });

  it("迟到的列表响应不能恢复已确认删除的会话", async () => {
    const { result } = await openSession();
    const list = deferred<Response>();
    authFetchMock.mockImplementation((_url: string, init?: RequestInit) => init?.method === "DELETE" ? Promise.resolve(json({ ok: true })) : list.promise);
    let loading!: Promise<void>;
    act(() => { loading = result.current.loadSessions({ fresh: true }); });
    await act(async () => { await result.current.handleDeleteSession(); });
    await act(async () => { list.resolve(json({ sessions, hasMore: false })); await loading; });
    expect(result.current.sessions.map((item) => item.sessionId)).toEqual(["session-b"]);
    expect(result.current.sessionId).toBeNull();
  });

  it("批量部分失败只移除成功项，当前会话成功删除后留在新建页", async () => {
    const { result } = await openSession();
    act(() => result.current.confirmDeleteSessions(["session-a", "session-b"]));
    authFetchMock.mockImplementation(async (url: string) => json({}, url.includes("session-b") ? 500 : 200));
    await act(async () => { await result.current.handleDeleteSession(); });
    expect(result.current.sessions.map((item) => item.sessionId)).toEqual(["session-b"]);
    expect(result.current.sessionId).toBeNull();
    expect(window.alert).toHaveBeenCalledWith("1 个会话删除失败");
  });

  it("重复确认与广播先到时只发一次 DELETE、只初始化一次新建页", async () => {
    const { result, cb } = await openSession();
    const deletion = deferred<Response>();
    authFetchMock.mockClear().mockReturnValue(deletion.promise);
    let pending!: Promise<void>;
    act(() => { pending = result.current.handleDeleteSession(); void result.current.handleDeleteSession(); });
    expect(authFetchMock).toHaveBeenCalledTimes(1);
    act(() => result.current.removeSession("session-a"));
    await act(async () => { deletion.resolve(json({ ok: true })); await pending; });
    expect(cb.onNewSession).toHaveBeenCalledOnce();
  });

  it("广播删除时作废仍在加载的会话详情", async () => {
    const { result, cb } = await openSession();
    const detail = deferred<Response>();
    authFetchMock.mockReturnValue(detail.promise);
    cb.setMessages = vi.fn();
    let pending!: Promise<void>;
    act(() => { pending = result.current.loadSessionDetail("session-a"); });
    act(() => result.current.removeSession("session-a"));
    await act(async () => { detail.resolve(json({ blocks: [{ id: "old", kind: "text", content: "旧消息" }] })); await pending; });
    expect(result.current.sessionId).toBeNull();
    expect(cb.setMessages).not.toHaveBeenCalled();
  });
});
