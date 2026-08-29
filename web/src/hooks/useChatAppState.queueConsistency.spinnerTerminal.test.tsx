import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatAppState } from "./useChatAppState";
import type { UploadedFile } from "@/components/types";

const harness = vi.hoisted(() => {
  const messageHandlers = new Set<(envelope: { data: unknown }) => void>();
  const stateHandlers = new Set<(state: string) => void>();
  return {
    messageHandlers,
    stateHandlers,
    sends: vi.fn(async (_payload: unknown) => true),
    authFetch: vi.fn(async (_url: string, _init?: unknown): Promise<Response> => new Response("{}", { status: 404 })),
    currentFiles: [] as UploadedFile[],
    replaceFiles: vi.fn((files: UploadedFile[]) => {
      harness.currentFiles = files;
    }),
    sessionCallbacks: null as null | {
      onQueuedMessages?: (sessionId: string, messages: unknown[]) => void;
      cancelActiveStream?: () => void;
    },
    session: {
      sessionId: null as string | null,
      sessions: [],
      isLoadingSessions: false,
      isLoadingMessages: false,
      hasMoreHistory: false,
      isLoadingEarlier: false,
      loadEarlierMessages: vi.fn(async () => {}),
      deleteSessionId: null,
      deleteSessionCount: 0,
      isNewSession: true,
      tokenUsage: null,
      contextUsage: null,
      setContextUsage: vi.fn(),
      hasMore: false,
      isLoadingMore: false,
      loadDetailPromiseRef: { current: Promise.resolve() },
      sessionOwner: null,
      setSessionId: vi.fn(),
      loadSessions: vi.fn(async () => {}),
      loadMoreSessions: vi.fn(async () => {}),
      loadSessionDetail: vi.fn(async () => {}),
      newSession: vi.fn(),
      selectSession: vi.fn((id: string) => {
        // TASK-312 review#2：真实 useSession.selectSession 会先 cancelActiveStream（detach/dump），harness 必须具备该切换语义。
        harness.sessionCallbacks?.cancelActiveStream?.();
        harness.session.sessionId = id;
        harness.session.isNewSession = false;
      }),
      confirmDeleteSession: vi.fn(),
      confirmDeleteSessions: vi.fn(),
      cancelDeleteSession: vi.fn(),
      handleDeleteSession: vi.fn(async () => {}),
      renameSession: vi.fn(async () => true),
      autoTitleSession: vi.fn(async () => true),
      updateSessionTitle: vi.fn(),
      updateSessionMeta: vi.fn(),
      removeSession: vi.fn(),
      upsertSession: vi.fn(),
      refreshTokenUsage: vi.fn(async () => {}),
      setIsNewSession: vi.fn(),
      refreshCurrentSession: vi.fn(),
      loadGroupSessions: vi.fn(async () => {}),
    },
  };
});

vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/hooks/useSession", () => ({
  useSession: (callbacks: typeof harness.sessionCallbacks) => {
    harness.sessionCallbacks = callbacks;
    return harness.session;
  },
}));
vi.mock("@/hooks/useFileUpload", () => ({
  useFileUpload: () => ({
    uploadedFiles: harness.currentFiles,
    uploading: false,
    uploadError: null,
    dismissUploadError: vi.fn(),
    isDragging: false,
    replaceFiles: harness.replaceFiles,
    removeFile: vi.fn(),
    handleFileSelect: vi.fn(async () => {}),
    handlePaste: vi.fn(async () => {}),
    handleDragOver: vi.fn(),
    handleDragLeave: vi.fn(),
    handleDrop: vi.fn(async () => {}),
    clearFiles: vi.fn(() => { harness.currentFiles = []; }),
    consumeFiles: vi.fn(() => []),
    setIsDragging: vi.fn(),
  }),
}));
vi.mock("@/lib/authFetch", () => ({
  authFetch: (url: string, init?: unknown) => harness.authFetch(url, init),
}));
vi.mock("@/lib/wsClient", () => ({
  wsClient: {
    currentState: "connected",
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(),
    send: vi.fn(() => true),
    ensureConnectedSend: (payload: unknown) => harness.sends(payload),
    forceReconnect: vi.fn(async () => {}),
    setLastSeq: vi.fn(),
    setEpoch: vi.fn(),
    onMessage: (handler: (envelope: { data: unknown }) => void) => {
      harness.messageHandlers.add(handler);
      return () => harness.messageHandlers.delete(handler);
    },
    onStateChange: (handler: (state: string) => void) => {
      harness.stateHandlers.add(handler);
      return () => harness.stateHandlers.delete(handler);
    },
  },
}));

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emit(data: unknown): void {
  for (const handler of [...harness.messageHandlers]) handler({ data });
}

beforeEach(() => {
  harness.messageHandlers.clear();
  harness.stateHandlers.clear();
  harness.sends.mockClear();
  harness.replaceFiles.mockClear();
  harness.currentFiles = [];
  harness.session.sessionId = null;
  harness.session.isNewSession = true;
  Object.values(harness.session).forEach((value) => {
    if (typeof value === "function" && "mockClear" in value) (value as ReturnType<typeof vi.fn>).mockClear();
  });
  harness.authFetch.mockReset().mockResolvedValue(response({}, 404));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// TASK-312 回归：终态必须「最终清除、不刷新页面」，但不得在 terminal -> next-run
// handoff 空窗立即清 Map（侧边栏转圈闪断/列表回跳）。收敛由 750ms 延迟探活配合
// /stream-status 权威结果完成；version 仲裁让下一 run lifecycle 的旧终态探活失效。
describe("useChatAppState sidebar spinner terminal convergence", () => {
  function startRunningSession(result: { current: ReturnType<typeof useChatAppState> }) {
    act(() => result.current.selectSession("session-a"));
    act(() => {
      emit({ type: "session_status", sessionId: "session-a", status: "running", streamId: "stream-a", runId: "run-a" });
    });
    expect(result.current.loading).toBe(true);
    expect(result.current.runningSessionIds.has("session-a")).toBe(true);
  }

  function emitTerminalSequence() {
    // 服务端真实投影顺序：session_status(terminal) 先到（defer latch 保活），done 紧随其后收口 UI。
    act(() => {
      emit({ type: "session_status", sessionId: "session-a", status: "completed", streamId: "stream-a", runId: "run-a" });
      emit({ type: "done", sessionId: "session-a", streamId: "stream-a", runId: "run-a" });
    });
  }

  it("keeps the latch through done and clears the spinner after the probe confirms no next run", async () => {
    vi.useFakeTimers();
    harness.session.sessionId = "session-a";
    harness.session.isNewSession = false;
    const { result } = renderHook(() => useChatAppState());
    startRunningSession(result);

    emitTerminalSequence();
    expect(result.current.loading).toBe(false);
    // handoff 空窗：done 不得立即清 active latch（否则列表转圈闪断/回跳旧时间）。
    expect(result.current.runningSessionIds.has("session-a")).toBe(true);

    harness.authFetch.mockImplementation(async (url: string) => (
      url.endsWith("/stream-status") ? response({ active: false }) : response({}, 404)
    ));
    await act(async () => {
      vi.advanceTimersByTime(750);
      await Promise.resolve();
      await Promise.resolve();
    });

    // 无下一 run：权威 inactive 后终态最终清除，无需刷新页面。
    expect(result.current.runningSessionIds.has("session-a")).toBe(false);
    expect(result.current.sessionRuntimeStatuses.get("session-a")).toBeUndefined();
    expect(result.current.loading).toBe(false);
  });

  it("keeps the spinner through done when the probe confirms the next run is active", async () => {
    vi.useFakeTimers();
    harness.session.sessionId = "session-a";
    harness.session.isNewSession = false;
    const { result } = renderHook(() => useChatAppState());
    startRunningSession(result);

    emitTerminalSequence();
    expect(result.current.runningSessionIds.has("session-a")).toBe(true);

    harness.authFetch.mockImplementation(async (url: string) => (
      url.endsWith("/stream-status")
        ? response({ active: true, status: "waiting_user", streamId: "stream-next", runId: "run-next" })
        : response({}, 404)
    ));
    await act(async () => {
      vi.advanceTimersByTime(750);
      await Promise.resolve();
      await Promise.resolve();
    });

    // 有下一 run：handoff 期间 runningSessionIds 不变 false，最终收敛为下一 run 的精确 active status。
    expect(result.current.runningSessionIds.has("session-a")).toBe(true);
    expect(result.current.sessionRuntimeStatuses.get("session-a")).toBe("waiting_user");
  });

  it("lets a next-run lifecycle invalidate the stale terminal probe via version arbitration", async () => {
    vi.useFakeTimers();
    harness.session.sessionId = "session-a";
    harness.session.isNewSession = false;
    const { result } = renderHook(() => useChatAppState());
    startRunningSession(result);

    emitTerminalSequence();
    expect(result.current.runningSessionIds.has("session-a")).toBe(true);

    // 下一 run lifecycle 在探活窗口内到达：version 仲裁必须让旧终态探活失效。
    act(() => {
      emit({ type: "session_status", sessionId: "session-a", status: "running", streamId: "stream-next", runId: "run-next" });
    });

    harness.authFetch.mockImplementation(async (url: string) => (
      url.endsWith("/stream-status") ? response({ active: false }) : response({}, 404)
    ));
    await act(async () => {
      vi.advanceTimersByTime(750);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.runningSessionIds.has("session-a")).toBe(true);
    expect(result.current.sessionRuntimeStatuses.get("session-a")).toBe("running");
  });

  it("clears a detached session's spinner when its terminal session_status arrives after switching away", () => {
    harness.session.sessionId = "session-a";
    harness.session.isNewSession = false;
    const { result } = renderHook(() => useChatAppState());

    act(() => {
      emit({ type: "session_status", sessionId: "session-a", status: "running", streamId: "stream-a", runId: "run-a" });
    });
    expect(result.current.runningSessionIds.has("session-a")).toBe(true);

    act(() => {
      result.current.selectSession("session-b");
    });

    // 切走后旧会话的 done 会被防串流守卫吞掉；detached 终态由 session_status 非延迟路径直接写 Map。
    act(() => {
      emit({ type: "session_status", sessionId: "session-a", status: "completed", streamId: "stream-a", runId: "run-a" });
    });

    expect(result.current.runningSessionIds.has("session-a")).toBe(false);
  });

  it("keeps an active run when a sessionId-less reject done arrives", () => {    harness.session.sessionId = "session-a";
    harness.session.isNewSession = false;
    const { result } = renderHook(() => useChatAppState());
    act(() => result.current.selectSession("session-a"));

    act(() => {
      emit({ type: "session_status", sessionId: "session-a", status: "running", streamId: "stream-a", runId: "run-a" });
    });
    expect(result.current.runningSessionIds.has("session-a")).toBe(true);

    act(() => {
      // 早期拒绝的 done（只有 client_msg_id，无 sessionId）不代表 run 终态，不得清掉真实运行中的会话。
      emit({ type: "done", client_msg_id: "cm-1", error: "rejected" });
    });

    expect(result.current.runningSessionIds.has("session-a")).toBe(true);
  });

  it("still converges the terminal when the user switches away inside the probe window", async () => {
    // TASK-312 review#2 缺口：terminal/done 之后、750ms 探活之前切换会话，
    // 真实切换语义（selectSession -> cancelActiveStream -> detach -> dump）不得取消旧会话终态探活。
    vi.useFakeTimers();
    harness.session.sessionId = "session-a";
    harness.session.isNewSession = false;
    const { result } = renderHook(() => useChatAppState());
    startRunningSession(result);

    emitTerminalSequence();
    expect(result.current.loading).toBe(false);
    expect(result.current.runningSessionIds.has("session-a")).toBe(true);

    // 探活窗口内切到 session-b（触发 cancelActiveStream/dump）。
    act(() => {
      result.current.selectSession("session-b");
    });
    expect(result.current.runningSessionIds.has("session-a")).toBe(true);

    harness.authFetch.mockImplementation(async (url: string) => (
      url.endsWith("/stream-status") ? response({ active: false }) : response({}, 404)
    ));
    await act(async () => {
      vi.advanceTimersByTime(750);
      await Promise.resolve();
      await Promise.resolve();
    });

    // dump 只是 ref->Map 同步，不能让唯一终态探活失效：旧会话 spinner 必须收敛清除。
    expect(result.current.runningSessionIds.has("session-a")).toBe(false);
    expect(result.current.sessionRuntimeStatuses.get("session-a")).toBeUndefined();
  });
});
