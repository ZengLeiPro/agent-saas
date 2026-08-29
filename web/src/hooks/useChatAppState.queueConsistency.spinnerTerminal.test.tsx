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
      selectSession: vi.fn(),
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
  harness.authFetch.mockReset().mockResolvedValue(new Response("{}", { status: 404 }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

// TASK-312 回归：done 终态必须同步写 per-session runtime Map，否则 defer latch 让
// ws 源 active 永久残留，侧边栏转圈只有整页刷新才消失。
describe("useChatAppState sidebar spinner terminal convergence", () => {
  it("clears the spinner when the current session's run completes via session_status + done", () => {
    harness.session.sessionId = "session-a";
    harness.session.isNewSession = false;
    const { result } = renderHook(() => useChatAppState());
    act(() => result.current.selectSession("session-a"));

    act(() => {
      emit({ type: "session_status", sessionId: "session-a", status: "running", streamId: "stream-a", runId: "run-a" });
    });
    expect(result.current.loading).toBe(true);
    expect(result.current.runningSessionIds.has("session-a")).toBe(true);

    act(() => {
      // 服务端终态投影顺序：session_status(completed) 先到，defer latch 暂不写 Map。
      emit({ type: "session_status", sessionId: "session-a", status: "completed", streamId: "stream-a", runId: "run-a" });
      emit({ type: "done", sessionId: "session-a", streamId: "stream-a", runId: "run-a" });
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.runningSessionIds.has("session-a")).toBe(false);
    expect(result.current.sessionRuntimeStatuses.get("session-a")).toBeUndefined();
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

  it("keeps an active run when a sessionId-less reject done arrives", () => {
    harness.session.sessionId = "session-a";
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
});
