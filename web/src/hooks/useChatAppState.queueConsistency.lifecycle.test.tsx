import { act, renderHook, waitFor } from "@testing-library/react";
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

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emit(data: unknown): void {
  for (const handler of [...harness.messageHandlers]) handler({ data });
}

function chatPayloads(): Array<Record<string, unknown>> {
  return harness.sends.mock.calls
    .map(([payload]) => payload as Record<string, unknown>)
    .filter((payload) => payload.action === "chat");
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
  let id = 0;
  vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useChatAppState queue consistency lifecycle", () => {
  it("仅在表单回答得到服务端确认后才标记已回答和排队", async () => {
    harness.session.sessionId = "session-ask";
    harness.session.isNewSession = false;
    const { result } = renderHook(() => useChatAppState());

    act(() => emit({
      type: "ask_user",
      interactionId: "ask-1",
      questions: [{ question: "继续吗？", header: "确认", options: [{ label: "继续", description: "" }], multiSelect: false }],
    }));
    expect(result.current.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "ask_user", interactionId: "ask-1", status: "pending" }),
    ]));

    const rejected = result.current.handleAskUserResponse("ask-1", { "继续吗？": "继续" });
    await waitFor(() => expect(harness.sends).toHaveBeenCalledWith(expect.objectContaining({
      action: "respond", interactionId: "ask-1",
    })));
    expect(result.current.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "ask_user", interactionId: "ask-1", status: "pending" }),
    ]));

    act(() => emit({ type: "respond_error", interactionId: "ask-1", error: "Run unavailable" }));
    await act(async () => { await rejected; });
    expect(result.current.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "ask_user", interactionId: "ask-1", status: "pending" }),
    ]));

    const accepted = result.current.handleAskUserResponse("ask-1", { "继续吗？": "继续" });
    await waitFor(() => expect(harness.sends.mock.calls.filter(([payload]) => (
      (payload as { action?: string }).action === "respond"
    ))).toHaveLength(2));
    act(() => emit({ type: "respond_ok", interactionId: "ask-1" }));
    await accepted;
    expect(result.current.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "ask_user", interactionId: "ask-1", status: "answered" }),
      expect.objectContaining({ type: "runtime_status", status: "queued" }),
    ]));
  });

  it("reattaches a cold switched session before accepting text and done", async () => {
    harness.session.sessionId = "session-old";
    harness.session.isNewSession = false;
    const { result, rerender } = renderHook(() => useChatAppState());

    act(() => {
      // The WS event can race React's session state commit in the same click frame.
      result.current.selectSession("session-active");
      emit({
        type: "active_stream",
        sessionId: "session-active",
        active: true,
        streamId: "stream-active",
        runId: "run-active",
        status: "running",
      });
    });
    expect(result.current.loading).toBe(true);

    harness.session.sessionId = "session-active";
    rerender();
    act(() => {
      emit({ type: "block_start", blockType: "text", runId: "run-active" });
      emit({ type: "text", content: "recovered reply" });
      emit({
        type: "done",
        sessionId: "session-active",
        streamId: "stream-active",
        runId: "run-active",
      });
    });

    await waitFor(() => expect(result.current.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "text", content: "recovered reply" }),
    ])));
    expect(result.current.loading).toBe(false);
  });

  it("does not let late session A active_stream/text/done leak into session B in the switch frame", () => {
    harness.session.sessionId = "session-a";
    harness.session.isNewSession = false;
    const { result } = renderHook(() => useChatAppState());
    harness.session.selectSession.mockImplementationOnce(() => {
      harness.sessionCallbacks?.cancelActiveStream?.();
    });

    act(() => {
      result.current.selectSession("session-b");
      emit({
        type: "active_stream",
        sessionId: "session-a",
        active: true,
        streamId: "stream-a",
        runId: "run-a",
        status: "running",
      });
      emit({ type: "block_start", blockType: "text", runId: "run-a" });
      emit({ type: "text", content: "late reply from A" });
      emit({
        type: "done",
        sessionId: "session-a",
        streamId: "stream-a",
        runId: "run-a",
      });
    });

    expect(result.current.messages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ content: expect.stringContaining("late reply from A") }),
    ]));
    expect(result.current.loading).toBe(false);
  });

  it("drops the temporary reconnect active_stream handler after switching sessions", () => {
    harness.session.sessionId = "session-a";
    harness.session.isNewSession = false;
    const { result } = renderHook(() => useChatAppState());

    act(() => {
      emit({
        type: "active_stream",
        sessionId: "session-a",
        active: true,
        streamId: "stream-a",
        runId: "run-a",
        status: "running",
      });
    });
    expect(result.current.loading).toBe(true);
    harness.session.refreshCurrentSession.mockClear();

    // connected while loading installs the one-shot reconnect handler for session A.
    act(() => {
      for (const handler of [...harness.stateHandlers]) handler("connected");
    });
    const handlersWithReconnect = harness.messageHandlers.size;

    act(() => {
      result.current.selectSession("session-b");
      emit({ type: "active_stream", sessionId: "session-a", active: false });
    });

    expect(harness.session.refreshCurrentSession).not.toHaveBeenCalled();
    expect(harness.messageHandlers.size).toBe(handlersWithReconnect - 1);
  });

  it("ignores a correlated inactive resume response that arrives after a new stream_id binding", async () => {
    harness.session.sessionId = "session-a";
    harness.session.isNewSession = false;
    const { result } = renderHook(() => useChatAppState());

    await waitFor(() => expect(harness.sends.mock.calls.some(([payload]) => (
      (payload as { action?: string }).action === "resume"
    ))).toBe(true));
    const resume = harness.sends.mock.calls
      .map(([payload]) => payload as { action?: string; requestId?: string })
      .find((payload) => payload.action === "resume");
    expect(resume?.requestId).toBeTruthy();

    act(() => {
      emit({
        type: "active_stream",
        sessionId: "session-a",
        active: true,
        streamId: "stream-old",
        runId: "run-old",
        requestId: resume?.requestId,
      });
    });
    expect(result.current.loading).toBe(true);

    act(() => {
      emit({
        type: "stream_id",
        sessionId: "session-a",
        streamId: "stream-new",
        runId: "run-new",
      });
    });
    expect(result.current.loading).toBe(true);
    harness.session.refreshCurrentSession.mockClear();

    act(() => {
      emit({
        type: "active_stream",
        sessionId: "session-a",
        active: false,
        requestId: resume?.requestId,
      });
    });

    expect(result.current.loading).toBe(true);
    expect(harness.session.refreshCurrentSession).not.toHaveBeenCalled();
  });

  it("treats a late HTTP inactive result as stale after a new lifecycle binding", async () => {
    harness.session.sessionId = "session-a";
    harness.session.isNewSession = false;
    let resolveStreamStatus!: (value: Response) => void;
    harness.authFetch.mockImplementation((url: string) => (
      url.endsWith("/stream-status")
        ? new Promise<Response>((resolve) => { resolveStreamStatus = resolve; })
        : Promise.resolve(response({}, 404))
    ));
    const { result } = renderHook(() => useChatAppState());

    await waitFor(() => expect(resolveStreamStatus).toBeTypeOf("function"));
    act(() => emit({
      type: "session_status",
      sessionId: "session-a",
      status: "running",
      streamId: "stream-new",
      runId: "run-new",
    }));
    await act(async () => { resolveStreamStatus(response({ active: false })); });
    await waitFor(() => expect(harness.sends.mock.calls.some(([payload]) => (
      (payload as { action?: string }).action === "resume"
    ))).toBe(true));

    act(() => result.current.stopGeneration());
    expect(result.current.loading).toBe(true);
    expect(harness.sends.mock.calls.map(([payload]) => payload)).toContainEqual({
      action: "abort",
      runId: "run-new",
      streamId: "stream-new",
    });
  });

  it("protects a new active lifecycle without IDs from old correlated and legacy inactive responses", async () => {
    harness.session.sessionId = "session-a";
    harness.session.isNewSession = false;
    const { result } = renderHook(() => useChatAppState());

    await waitFor(() => expect(harness.sends.mock.calls.some(([payload]) => (
      (payload as { action?: string }).action === "resume"
    ))).toBe(true));
    const oldResume = harness.sends.mock.calls
      .map(([payload]) => payload as { action?: string; requestId?: string })
      .find((payload) => payload.action === "resume");

    act(() => emit({
      type: "session_status",
      sessionId: "session-a",
      status: "running",
    }));
    harness.session.refreshCurrentSession.mockClear();
    act(() => {
      emit({
        type: "active_stream",
        sessionId: "session-a",
        active: false,
        requestId: oldResume?.requestId,
      });
      emit({ type: "active_stream", sessionId: "session-a", active: false });
    });

    expect(result.current.loading).toBe(true);
    expect(result.current.sessionRuntimeStatuses.get("session-a")).toBe("running");
    expect(harness.session.refreshCurrentSession).toHaveBeenCalledTimes(1);
  });

  it("does not resurrect a terminal lifecycle with an older correlated active response", async () => {
    harness.session.sessionId = "session-a";
    harness.session.isNewSession = false;
    const { result } = renderHook(() => useChatAppState());

    await waitFor(() => expect(harness.sends.mock.calls.some(([payload]) => (
      (payload as { action?: string }).action === "resume"
    ))).toBe(true));
    const oldResume = harness.sends.mock.calls
      .map(([payload]) => payload as { action?: string; requestId?: string })
      .find((payload) => payload.action === "resume");

    act(() => {
      emit({ type: "session_status", sessionId: "session-a", status: "completed" });
      emit({
        type: "active_stream",
        sessionId: "session-a",
        active: true,
        streamId: "stream-old",
        runId: "run-old",
        requestId: oldResume?.requestId,
      });
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.sessionRuntimeStatuses.get("session-a")).toBeUndefined();
    expect(result.current.runningSessionIds.has("session-a")).toBe(false);
  });

  it("invalidates an older correlated response when session_status establishes a new binding", async () => {
    harness.session.sessionId = "session-a";
    harness.session.isNewSession = false;
    const { result } = renderHook(() => useChatAppState());

    await waitFor(() => expect(harness.sends.mock.calls.some(([payload]) => (
      (payload as { action?: string }).action === "resume"
    ))).toBe(true));
    const oldResume = harness.sends.mock.calls
      .map(([payload]) => payload as { action?: string; requestId?: string })
      .find((payload) => payload.action === "resume");

    act(() => emit({
      type: "session_status",
      sessionId: "session-a",
      status: "running",
      streamId: "stream-status-new",
      runId: "run-status-new",
    }));
    harness.session.refreshCurrentSession.mockClear();
    act(() => emit({
      type: "active_stream",
      sessionId: "session-a",
      active: false,
      requestId: oldResume?.requestId,
    }));
    act(() => result.current.stopGeneration());

    expect(result.current.loading).toBe(true);
    expect(harness.session.refreshCurrentSession).not.toHaveBeenCalled();
    expect(harness.sends.mock.calls.map(([payload]) => payload)).toContainEqual({
      action: "abort",
      runId: "run-status-new",
      streamId: "stream-status-new",
    });
  });

  it("resumes a different stream_started binding while already loading and rejects the older response", async () => {
    harness.session.sessionId = "session-a";
    harness.session.isNewSession = false;
    const { result } = renderHook(() => useChatAppState());

    await waitFor(() => expect(harness.sends.mock.calls.some(([payload]) => (
      (payload as { action?: string }).action === "resume"
    ))).toBe(true));
    const oldResume = harness.sends.mock.calls
      .map(([payload]) => payload as { action?: string; requestId?: string })
      .find((payload) => payload.action === "resume");
    act(() => emit({
      type: "active_stream",
      sessionId: "session-a",
      active: true,
      streamId: "stream-old",
      runId: "run-old",
      requestId: oldResume?.requestId,
    }));

    act(() => emit({
      type: "stream_started",
      sessionId: "session-a",
      streamId: "stream-started-new",
      runId: "run-started-new",
    }));
    await waitFor(() => expect(harness.sends.mock.calls.filter(([payload]) => (
      (payload as { action?: string }).action === "resume"
    ))).toHaveLength(2));
    harness.session.refreshCurrentSession.mockClear();
    act(() => emit({
      type: "active_stream",
      sessionId: "session-a",
      active: false,
      requestId: oldResume?.requestId,
    }));
    act(() => result.current.stopGeneration());

    expect(result.current.loading).toBe(true);
    expect(harness.session.refreshCurrentSession).not.toHaveBeenCalled();
    expect(harness.sends.mock.calls.map(([payload]) => payload)).toContainEqual({
      action: "abort",
      runId: "run-started-new",
      streamId: "stream-started-new",
    });
  });

  it("invalidates an older response when HTTP stream-status restores a new binding", async () => {
    harness.session.sessionId = "session-a";
    harness.session.isNewSession = false;
    const { result } = renderHook(() => useChatAppState());

    await waitFor(() => expect(harness.sends.mock.calls.some(([payload]) => (
      (payload as { action?: string }).action === "resume"
    ))).toBe(true));
    const oldResume = harness.sends.mock.calls
      .map(([payload]) => payload as { action?: string; requestId?: string })
      .find((payload) => payload.action === "resume");
    act(() => emit({
      type: "active_stream",
      sessionId: "session-a",
      active: true,
      streamId: "stream-old",
      runId: "run-old",
      requestId: oldResume?.requestId,
    }));

    harness.authFetch.mockImplementation(async (url: string) => (
      url.endsWith("/stream-status")
        ? response({ active: true, status: "running", streamId: "stream-http-new", runId: "run-http-new" })
        : response({}, 404)
    ));
    await act(async () => { await result.current.resumeCurrentStream(); });
    harness.session.refreshCurrentSession.mockClear();
    act(() => emit({
      type: "active_stream",
      sessionId: "session-a",
      active: false,
      requestId: oldResume?.requestId,
    }));
    act(() => result.current.stopGeneration());

    expect(result.current.loading).toBe(true);
    expect(harness.session.refreshCurrentSession).not.toHaveBeenCalled();
    expect(harness.sends.mock.calls.map(([payload]) => payload)).toContainEqual({
      action: "abort",
      runId: "run-http-new",
      streamId: "stream-http-new",
    });
  });

  it("ignores a legacy active response when only streamId differs and preserves an omitted runId", () => {
    harness.session.sessionId = "session-a";
    harness.session.isNewSession = false;
    const { result } = renderHook(() => useChatAppState());

    act(() => emit({
      type: "session_status",
      sessionId: "session-a",
      status: "running",
      streamId: "stream-current",
      runId: "run-current",
    }));
    act(() => emit({
      type: "active_stream",
      sessionId: "session-a",
      active: true,
      streamId: "stream-stale",
      runId: "run-current",
    }));
    act(() => emit({
      type: "active_stream",
      sessionId: "session-a",
      active: true,
      streamId: "stream-current",
    }));
    act(() => result.current.stopGeneration());

    expect(harness.sends.mock.calls.map(([payload]) => payload)).toContainEqual({
      action: "abort",
      runId: "run-current",
      streamId: "stream-current",
    });
  });

  it("keeps a new binding when a legacy server sends inactive or an active response for another run", async () => {
    harness.session.sessionId = "session-a";
    harness.session.isNewSession = false;
    const { result } = renderHook(() => useChatAppState());

    await waitFor(() => expect(harness.sends.mock.calls.some(([payload]) => (
      (payload as { action?: string }).action === "resume"
    ))).toBe(true));
    const resume = harness.sends.mock.calls
      .map(([payload]) => payload as { action?: string; requestId?: string })
      .find((payload) => payload.action === "resume");

    act(() => {
      emit({
        type: "active_stream",
        sessionId: "session-a",
        active: true,
        streamId: "stream-old",
        runId: "run-old",
        requestId: resume?.requestId,
      });
      emit({
        type: "stream_id",
        sessionId: "session-a",
        streamId: "stream-new",
        runId: "run-new",
      });
    });
    harness.session.refreshCurrentSession.mockClear();

    act(() => {
      emit({ type: "active_stream", sessionId: "session-a", active: false });
      emit({
        type: "active_stream",
        sessionId: "session-a",
        active: true,
        streamId: "stream-stale",
        runId: "run-stale",
      });
      result.current.stopGeneration();
    });

    expect(result.current.loading).toBe(true);
    expect(harness.session.refreshCurrentSession).toHaveBeenCalledTimes(1);
    expect(harness.sends.mock.calls.map(([payload]) => payload)).toContainEqual({
      action: "abort",
      runId: "run-new",
      streamId: "stream-new",
    });
  });

  it("binds queued entries from live and sync events to their authoritative session", async () => {
    harness.session.sessionId = "session-queue";
    harness.session.isNewSession = false;
    const { result } = renderHook(() => useChatAppState());
    await waitFor(() => expect(harness.sends.mock.calls.some(([payload]) => (
      (payload as { action?: string }).action === "resume"
    ))).toBe(true));
    const first = {
      type: "message_queued",
      sessionId: "session-queue",
      runId: "run-live",
      clientMsgId: "client-live",
      deliveryMode: "queue",
      content: "live queued",
      timestamp: 1,
    };
    const second = {
      ...first,
      runId: "run-sync",
      clientMsgId: "client-sync",
      content: "sync queued",
      timestamp: 2,
    };

    act(() => emit(first));
    act(() => emit({ type: "sync_ok", seq: 2, events: [{ seq: 2, event: second }] }));

    expect(result.current.queuedInterjections).toEqual(expect.arrayContaining([
      expect.objectContaining({ clientMsgId: "client-live", sessionId: "session-queue" }),
      expect.objectContaining({ clientMsgId: "client-sync", sessionId: "session-queue" }),
    ]));
  });

  it("locks later provisional submissions and flushes them in order with the authoritative sessionId", async () => {
    const { result } = renderHook(() => useChatAppState());

    act(() => result.current.setInput("first"));
    await act(async () => { await result.current.sendMessage(); });
    act(() => result.current.setInput("second"));
    await act(async () => { await result.current.sendMessage(); });

    expect(chatPayloads()).toHaveLength(1);
    expect(chatPayloads()[0].sessionId).toBeUndefined();
    expect(result.current.queuedInterjections.map((entry) => entry.content)).toEqual(["second"]);

    act(() => emit({
      type: "session",
      sessionId: "session-authoritative",
      client_msg_id: chatPayloads()[0].client_msg_id,
    }));

    await waitFor(() => expect(chatPayloads()).toHaveLength(2));
    expect(chatPayloads().map((payload) => payload.message)).toEqual(["first", "second"]);
    expect(chatPayloads()[1].sessionId).toBe("session-authoritative");
  });

  it("stops the remaining provisional flush when the user switches sessions mid-batch", async () => {
    let releaseInflight: (() => void) | undefined;
    const inflight = new Promise<void>((resolve) => { releaseInflight = resolve; });
    harness.sends.mockImplementation(async (payload: unknown) => {
      if ((payload as { message?: string }).message === "second") await inflight;
      return true;
    });
    const { result } = renderHook(() => useChatAppState());

    act(() => result.current.setInput("first"));
    await act(async () => { await result.current.sendMessage(); });
    act(() => result.current.setInput("second"));
    await act(async () => { await result.current.sendMessage(); });
    act(() => result.current.setInput("third"));
    await act(async () => { await result.current.sendMessage(); });

    const rootId = chatPayloads()[0].client_msg_id;
    act(() => emit({ type: "session", sessionId: "session-a", client_msg_id: rootId }));
    await waitFor(() => expect(chatPayloads().map((payload) => payload.message)).toEqual(["first", "second"]));
    act(() => result.current.selectSession("session-b"));
    releaseInflight?.();
    await act(async () => { await inflight; await Promise.resolve(); });

    expect(chatPayloads().map((payload) => payload.message)).toEqual(["first", "second"]);
    expect(harness.session.selectSession).toHaveBeenCalledWith("session-b");
  });

  it("fails only the rejected provisional batch and never flushes it into the next new session", async () => {
    const { result } = renderHook(() => useChatAppState());

    act(() => result.current.setInput("first"));
    await act(async () => { await result.current.sendMessage(); });
    const rejectedRootId = chatPayloads()[0].client_msg_id as string;
    act(() => result.current.setInput("must not leak"));
    await act(async () => { await result.current.sendMessage(); });

    act(() => emit({
      type: "chat_rejected",
      client_msg_id: rejectedRootId,
      reason_code: "server_draining",
      reason: "rejected",
    }));
    expect(result.current.queuedInterjections.find((entry) => entry.content === "must not leak")?.status).toBe("failed");

    act(() => result.current.newSession());
    act(() => result.current.setInput("next root"));
    await act(async () => { await result.current.sendMessage(); });
    const nextRootId = chatPayloads()[1].client_msg_id as string;
    act(() => emit({ type: "session", sessionId: "session-next", client_msg_id: nextRootId }));

    await waitFor(() => expect(chatPayloads()).toHaveLength(2));
    expect(chatPayloads().map((payload) => payload.message)).toEqual(["first", "next root"]);
  });

  it("drops a provisional batch on session switch and ignores the late session confirmation", async () => {
    const { result } = renderHook(() => useChatAppState());

    act(() => result.current.setInput("first"));
    await act(async () => { await result.current.sendMessage(); });
    const staleRootId = chatPayloads()[0].client_msg_id as string;
    act(() => result.current.setInput("must stay local"));
    await act(async () => { await result.current.sendMessage(); });

    act(() => result.current.selectSession("existing-session"));
    act(() => emit({ type: "session", sessionId: "stale-session", client_msg_id: staleRootId }));

    await waitFor(() => expect(chatPayloads()).toHaveLength(1));
    expect(result.current.queuedInterjections.some((entry) => entry.content === "must stay local")).toBe(false);
    expect(harness.session.selectSession).toHaveBeenCalledWith("existing-session");
  });

  it("does not resurrect an already-projected message into the queue bar after switching sessions (TASK-70)", async () => {
    harness.session.sessionId = "session-queue";
    harness.session.isNewSession = false;
    const { result } = renderHook(() => useChatAppState());
    await waitFor(() => expect(harness.sends.mock.calls.some(([payload]) => (
      (payload as { action?: string }).action === "resume"
    ))).toBe(true));

    // 1. 消息排队 → 队列卡片出现
    act(() => emit({
      type: "message_queued",
      sessionId: "session-queue",
      runId: "run-projected",
      clientMsgId: "client-projected",
      deliveryMode: "queue",
      content: "已经发送",
      timestamp: 1,
    }));
    expect(result.current.queuedInterjections.map((entry) => entry.clientMsgId)).toContain("client-projected");

    // 2. user_message 投影 → 消费标记 + 移除队列卡片
    act(() => emit({
      type: "user_message",
      sessionId: "session-queue",
      content: "已经发送",
      client_msg_id: "client-projected",
      sourceRunId: "run-projected",
      timestamp: 2,
    }));
    expect(result.current.queuedInterjections.map((entry) => entry.clientMsgId)).not.toContain("client-projected");

    // 3. 切会话（detachFromStream 不再清空消费标记）
    act(() => { harness.sessionCallbacks?.cancelActiveStream?.(); });

    // 4. 切回会话 A：detail 短暂返回旧 pending 快照（已投影但 source run 尚未转出 pending）
    act(() => {
      harness.sessionCallbacks?.onQueuedMessages?.("session-queue", [{
        sourceRunId: "run-projected",
        runId: "run-projected",
        clientMsgId: "client-projected",
        deliveryMode: "queue",
        content: "已经发送",
        acceptedAt: "2026-08-17T00:00:00.000Z",
      }]);
    });

    // 5. 消费标记跨会话保留，旧快照不得复活已发送消息
    expect(result.current.queuedInterjections.map((entry) => entry.clientMsgId)).not.toContain("client-projected");
    expect(result.current.queuedInterjections).toEqual([]);
  });

});
