import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatAppState } from "./useChatAppState";
import type { UploadedFile } from "@/components/types";
import type { CanonicalChatSubmissionWireMessage, ChatQueueSnapshot } from "@agent/shared";
const harness = vi.hoisted(() => {
  const messageHandlers = new Set<(envelope: { data: unknown }) => void>();
  const stateHandlers = new Set<(state: string) => void>();
  return {
    messageHandlers,
    stateHandlers,
    sends: vi.fn(async (_payload: unknown) => true),
    forceReconnect: vi.fn(async () => {}),
    authFetch: vi.fn(async (_url: string, _init?: unknown): Promise<Response> => new Response("{}", { status: 404 })),
    pendingOrgAgentIdRef: { current: null as string | null },
    pendingNewSessionGroupIdRef: { current: null as string | null },
    assignPendingGroup: vi.fn(),
    currentFiles: [] as UploadedFile[],
    replaceFiles: vi.fn((files: UploadedFile[]) => {
      harness.currentFiles = files;
    }),
    sessionCallbacks: null as null | {
      onSessionsLoaded?: (sessions: Array<{ sessionId: string }>) => void;
      onLastRunState?: (sessionId: string, lastRunState: { status: string; runId: string; error?: string }) => void;
      onQueuedMessages?: (sessionId: string, messages: unknown[]) => void;
      onQueueSnapshot?: (sessionId: string, snapshot: ChatQueueSnapshot) => void;
      onSandboxProfile?: (sessionId: string, profile: "daily" | "coding" | undefined, activate?: boolean) => void; onSessionInvalidated?: (sessionId: string, status: 403 | 404) => void;
      onNewSession?: () => void;
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
    reportUploadError: vi.fn(),
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
vi.mock("@/hooks/usePendingNewSessionTarget", () => ({
  usePendingNewSessionTarget: () => ({
    pendingOrgAgentIdRef: harness.pendingOrgAgentIdRef,
    pendingNewSessionGroupIdRef: harness.pendingNewSessionGroupIdRef,
    pendingOrgAgentId: null,
    setPendingOrgAgentId: vi.fn(),
    clearPendingOrgAgent: vi.fn(),
    assignPendingGroup: harness.assignPendingGroup,
  }),
}));
vi.mock("@/lib/wsClient", () => ({
  wsClient: {
    currentState: "connected",
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(),
    send: vi.fn(() => true),
    ensureConnectedSend: (payload: unknown) => harness.sends(payload),
    forceReconnect: () => harness.forceReconnect(),
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
function response(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }
function emit(data: unknown): void { for (const handler of [...harness.messageHandlers]) handler({ data }); }
function chatPayloads(): CanonicalChatSubmissionWireMessage[] {
  return harness.sends.mock.calls
    .map(([payload]) => payload as CanonicalChatSubmissionWireMessage)
    .filter((payload) => payload.action === "chat");
}
const fileA: UploadedFile = {
  attachmentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  originalName: "a.png",
  savedPath: "/uploads/a.png",
  relativePath: "uploads/a.png",
  size: 123,
  mimeType: "image/png",
  isImage: true,
};
const fileB: UploadedFile = {
  attachmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  originalName: "b.pdf",
  savedPath: "/uploads/b.pdf",
  relativePath: "uploads/b.pdf",
  size: 456,
  mimeType: "application/pdf",
  isImage: false,
};
beforeEach(() => {
  window.history.replaceState(null, "", "/chat");
  harness.messageHandlers.clear();
  harness.stateHandlers.clear();
  harness.sends.mockClear();
  harness.forceReconnect.mockReset().mockResolvedValue(undefined);
  harness.assignPendingGroup.mockClear();
  harness.pendingOrgAgentIdRef.current = null;
  harness.pendingNewSessionGroupIdRef.current = null;
  harness.replaceFiles.mockClear();
  harness.currentFiles = [];
  harness.session.sessionId = null;
  harness.session.isNewSession = true;
  Object.values(harness.session).forEach((value) => {
    if (typeof value === "function" && "mockClear" in value) (value as ReturnType<typeof vi.fn>).mockClear();
  });
  harness.session.newSession.mockImplementation(() => harness.sessionCallbacks?.onNewSession?.());
  harness.session.selectSession.mockImplementation((sessionId: string) => harness.sessionCallbacks?.onSandboxProfile?.(sessionId, undefined, true));
  harness.session.removeSession.mockImplementation((sessionId: string) => {
    if (harness.session.sessionId !== sessionId) return;
    harness.session.sessionId = null;
    harness.sessionCallbacks?.onNewSession?.();
  });
  harness.authFetch.mockReset().mockResolvedValue(response({}, 404));
  let id = 0;
  vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("useChatAppState queue delivery lifecycle", () => {
  it("defaults new conversations to daily and sends the selected profile on the first WS chat", async () => {
    const { result } = renderHook(() => useChatAppState());
    expect(result.current.sandboxProfile).toBe("daily");
    act(() => {
      result.current.setSandboxProfile("coding");
      result.current.setInput("compile this");
    });
    await act(async () => { await result.current.sendMessage(); });
    expect(chatPayloads()[0]).toMatchObject({
      submission: { text: "compile this", target: { sandboxProfile: "coding" } },
    });
  });
  it("locks existing sessions and falls back legacy details without sandboxProfile to coding", () => {
    const { result } = renderHook(() => useChatAppState());
    act(() => result.current.selectSession("legacy-session"));
    expect(result.current.sandboxProfile).toBe("coding");
    act(() => result.current.setSandboxProfile("daily"));
    expect(result.current.sandboxProfile).toBe("coding");
    act(() => harness.sessionCallbacks?.onSandboxProfile?.("legacy-session", undefined));
    expect(result.current.sandboxProfile).toBe("coding");
    act(() => harness.sessionCallbacks?.onSandboxProfile?.("legacy-session", "daily")); expect(result.current.sandboxProfile).toBe("daily");
    act(() => harness.sessionCallbacks?.onSandboxProfile?.("stale-session", undefined)); expect(result.current.sandboxProfile).toBe("daily"); act(() => harness.sessionCallbacks?.onSandboxProfile?.("next-legacy-session", undefined, true)); expect(result.current.sandboxProfile).toBe("coding");
  });
  it("returns to daily when browser navigation opens a blank new conversation", () => {
    const { result, rerender } = renderHook(() => useChatAppState());
    harness.session.sessionId = "coding-session"; rerender();
    act(() => harness.sessionCallbacks?.onSandboxProfile?.("coding-session", "coding"));
    expect(result.current.sandboxProfile).toBe("coding");
    window.history.pushState(null, "", "/chat/coding-session"); window.history.pushState(null, "", "/chat");
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(harness.session.newSession).toHaveBeenCalledOnce(); expect(result.current.sandboxProfile).toBe("daily");
  });
  it("locks the draft profile while the first message is pending and adopts the session event authority", async () => {
    const { result } = renderHook(() => useChatAppState());
    act(() => result.current.setInput("first message")); await act(async () => { await result.current.sendMessage(); });
    const clientMsgId = chatPayloads()[0]?.submission.clientMsgId as string;
    act(() => result.current.setSandboxProfile("coding")); expect(result.current.sandboxProfile).toBe("daily");
    act(() => emit({ type: "session", sessionId: "session-authoritative", client_msg_id: clientMsgId, sandboxProfile: "coding" }));
    expect(result.current.sandboxProfile).toBe("coding");
  });
  it("falls back a direct existing-session route to coding before detail succeeds", () => {
    window.history.replaceState(null, "", "/chat/direct-session"); harness.session.sessionId = "direct-session";
    const { result } = renderHook(() => useChatAppState());
    expect(result.current.sandboxProfile).toBe("coding");
  });
  it("falls back forward navigation to coding before detail succeeds", () => {
    const { result } = renderHook(() => useChatAppState());
    expect(result.current.sandboxProfile).toBe("daily");
    window.history.pushState(null, "", "/chat/forward-session"); act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(harness.session.selectSession).toHaveBeenCalledWith("forward-session"); expect(result.current.sandboxProfile).toBe("coding");
  });
  it("clears the active session synchronously and restores daily after a remote deletion", async () => {
    window.history.replaceState(null, "", "/chat/remote-session"); harness.session.sessionId = "remote-session";
    const { result } = renderHook(() => useChatAppState());
    act(() => emit({ type: "sync_ok", seq: 1, events: [{ event: { type: "session_deleted", sessionId: "remote-session" } }] }));
    expect(result.current.sandboxProfile).toBe("daily");
    act(() => result.current.setInput("after deletion")); await act(async () => { await result.current.sendMessage(); });
    expect(chatPayloads()[0]).toMatchObject({ submission: { target: { sandboxProfile: "daily" } } });
    expect(chatPayloads()[0].submission.target.sessionId).toBeUndefined();
  });
  it.each([403, 404] as const)("详情返回 %s 时跨非聊天页清除失效归属并恢复可选草稿", async (status) => {
    window.history.replaceState(null, "", "/chat/invalid-session"); harness.session.sessionId = "invalid-session"; harness.session.isNewSession = false; const { result, rerender } = renderHook(() => useChatAppState());
    act(() => result.current.setActiveTab("files")); expect(window.location.pathname).not.toContain("invalid-session"); act(() => harness.sessionCallbacks?.onSessionInvalidated?.("invalid-session", status));
    harness.session.sessionId = null; harness.session.isNewSession = true; rerender(); expect(result.current.sandboxProfile).toBe("daily"); act(() => result.current.setActiveTab("chat")); expect(window.location.pathname).not.toContain("invalid-session");
    act(() => { result.current.setSandboxProfile("coding"); result.current.setInput("after invalidation"); });
    await act(async () => { await result.current.sendMessage(); });
    expect(chatPayloads()[0]).toMatchObject({
      submission: { text: "after invalidation", target: { sandboxProfile: "coding" } },
    });
    expect(chatPayloads()[0].submission.target.sessionId).toBeUndefined();
  });
  it("reconnects away from a draining server and lets retry resend the rejected message", async () => {
    harness.session.sessionId = "session-draining";
    harness.session.isNewSession = false;
    const { result, rerender } = renderHook(() => useChatAppState());
    harness.currentFiles = [fileA];
    rerender();
    act(() => result.current.setInput("retry after restart"));
    await act(async () => { await result.current.sendMessage(); });
    const clientMsgId = chatPayloads()[0].submission.clientMsgId as string;
    act(() => emit({
      type: "chat_rejected",
      client_msg_id: clientMsgId,
      reason_code: "server_draining",
      reason: "服务即将关闭，请稍后重试",
    }));
    await waitFor(() => expect(harness.forceReconnect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.messages.find((message) => (
      message.type === "user" && message.clientMsgId === clientMsgId
    ))).toMatchObject({ status: "failed" }));
    const failedMessage = result.current.messages.find((message) => (
      message.type === "user" && message.clientMsgId === clientMsgId
    ));
    if (!failedMessage) throw new Error("rejected message bubble missing");
    act(() => result.current.retryMessage(failedMessage));
    await waitFor(() => expect(chatPayloads()).toHaveLength(2));
    expect(chatPayloads()[1]).toMatchObject({
      submission: {
        clientMsgId,
        text: "retry after restart",
        target: { sessionId: "session-draining" },
        attachments: [{
          attachmentId: fileA.attachmentId,
          display: {
            originalName: fileA.originalName,
            mimeType: fileA.mimeType,
            size: fileA.size,
            isImage: fileA.isImage,
          },
        }],
      },
    });
    expect(JSON.stringify(chatPayloads()[1])).not.toMatch(/savedPath|relativePath|\/uploads\//);
  });
  it("keeps a WS-confirmed runtime when stream-status is inactive during session restore", async () => {
    let resolveStreamStatus!: (value: Response) => void;
    harness.authFetch.mockImplementation((url: string) => (
      url.endsWith("/stream-status")
        ? new Promise<Response>((resolve) => { resolveStreamStatus = resolve; })
        : Promise.resolve(response({}, 404))
    ));
    const { result, rerender } = renderHook(() => useChatAppState());
    act(() => emit({
      type: "session_status",
      sessionId: "session-sleeping",
      status: "running",
      streamId: "stream-sleeping",
      runId: "run-sleeping",
    }));
    expect(result.current.runningSessionIds.has("session-sleeping")).toBe(true);
    harness.session.sessionId = "session-sleeping";
    harness.session.isNewSession = false;
    rerender();
    await waitFor(() => expect(resolveStreamStatus).toBeTypeOf("function"));
    await act(async () => { resolveStreamStatus(response({ active: false })); });
    expect(result.current.runningSessionIds.has("session-sleeping")).toBe(true);
    expect(result.current.sessionRuntimeStatuses.get("session-sleeping")).toBe("running");
  });
  it("keeps a snapshot-confirmed runtime while a clicked session waits for resume authority", async () => {
    harness.authFetch.mockImplementation(async (url: string) => {
      if (url === "/api/sessions/active-streams") {
        return response({ sessions: [{ sessionId: "session-sleeping", active: true, runId: "run-sleeping" }] });
      }
      if (url.endsWith("/stream-status")) return response({ active: false });
      return response({}, 404);
    });
    const { result, rerender } = renderHook(() => useChatAppState());
    await act(async () => {
      harness.sessionCallbacks?.onSessionsLoaded?.([{ sessionId: "session-sleeping" }]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.runningSessionIds.has("session-sleeping")).toBe(true);
    act(() => result.current.selectSession("session-sleeping"));
    expect(result.current.loading).toBe(true);
    harness.session.sessionId = "session-sleeping";
    harness.session.isNewSession = false;
    rerender();
    await waitFor(() => expect(harness.sends.mock.calls.some(([payload]) => (
      (payload as { action?: string }).action === "resume"
    ))).toBe(true));
    expect(result.current.runningSessionIds.has("session-sleeping")).toBe(true);
    expect(result.current.sessionRuntimeStatuses.get("session-sleeping")).toBe("running");
    const requestId = (harness.sends.mock.calls.find(([payload]) => (payload as { action?: string }).action === "resume")?.[0] as { requestId: string }).requestId;
    act(() => emit({
      type: "active_stream", sessionId: "session-sleeping", active: false, runId: "run-sleeping", requestId,
    }));
    expect(result.current.loading).toBe(false);
  });
  it("does not clear a current WS runtime from a stale terminal lastRunState", async () => {
    harness.session.sessionId = "session-running";
    harness.session.isNewSession = false;
    harness.authFetch.mockImplementation(async (url: string) => (
      url.endsWith("/stream-status") ? response({ active: true, runId: "run-running" }) : response({}, 404)
    ));
    const { result } = renderHook(() => useChatAppState());
    act(() => emit({
      type: "session_status",
      sessionId: "session-running",
      status: "running",
      streamId: "stream-running",
      runId: "run-running",
    }));
    await act(async () => {
      harness.sessionCallbacks?.onLastRunState?.("session-running", { status: "completed", runId: "run-previous" });
      await Promise.resolve();
    });
    expect(result.current.runningSessionIds.has("session-running")).toBe(true);
    expect(result.current.sessionRuntimeStatuses.get("session-running")).toBe("running");
  });
  it("keeps the list active across a terminal-to-next-run handoff", async () => {
    vi.useFakeTimers();
    harness.session.sessionId = "session-running";
    harness.session.isNewSession = false;
    const { result } = renderHook(() => useChatAppState());
    act(() => emit({
      type: "session_status",
      sessionId: "session-running",
      status: "running",
      streamId: "stream-previous",
      runId: "run-previous",
    }));
    harness.authFetch.mockImplementation(async (url: string) => (
      url.endsWith("/stream-status")
        ? response({ active: true, status: "waiting_user", streamId: "stream-next", runId: "run-next" })
        : response({}, 404)
    ));
    act(() => emit({
      type: "session_status",
      sessionId: "session-running",
      status: "completed",
      streamId: "stream-previous",
      runId: "run-previous",
    }));
    expect(result.current.runningSessionIds.has("session-running")).toBe(true);
    expect(result.current.sessionRuntimeStatuses.get("session-running")).toBe("running");
    await act(async () => {
      vi.advanceTimersByTime(750);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.runningSessionIds.has("session-running")).toBe(true);
    expect(result.current.sessionRuntimeStatuses.get("session-running")).toBe("waiting_user");
  });
  it("ignores a delayed inactive terminal lookup after a newer WS runtime", async () => {
    let resolveStreamStatus!: (value: Response) => void;
    harness.session.sessionId = "session-running";
    harness.session.isNewSession = false;
    harness.authFetch.mockImplementation((url: string) => (
      url.endsWith("/stream-status") ? new Promise<Response>((resolve) => { resolveStreamStatus = resolve; }) : Promise.resolve(response({}, 404))
    ));
    const { result } = renderHook(() => useChatAppState());

    await act(async () => {
      harness.sessionCallbacks?.onLastRunState?.("session-running", { status: "completed", runId: "run-previous" });
      await Promise.resolve();
    });
    act(() => emit({ type: "session_status", sessionId: "session-running", status: "running", streamId: "stream-current", runId: "run-current" }));
    await act(async () => { resolveStreamStatus(response({ active: false })); });

    expect(result.current.runningSessionIds.has("session-running")).toBe(true);
    expect(result.current.sessionRuntimeStatuses.get("session-running")).toBe("running");
  });

  it("does not let a stale terminal snapshot clear an ID-less active lifecycle", async () => {
    harness.session.sessionId = "session-running";
    harness.session.isNewSession = false;
    harness.authFetch.mockImplementation(async (url: string) => (
      url.endsWith("/stream-status") ? response({ active: false }) : response({}, 404)
    ));
    const { result } = renderHook(() => useChatAppState());

    act(() => emit({ type: "session_status", sessionId: "session-running", status: "running" }));
    await act(async () => {
      harness.sessionCallbacks?.onLastRunState?.("session-running", { status: "completed", runId: "run-previous" });
      await Promise.resolve();
    });

    expect(result.current.runningSessionIds.has("session-running")).toBe(true);
    expect(result.current.sessionRuntimeStatuses.get("session-running")).toBe("running");
  });

  it("does not let a same-run terminal detail clear snapshot-confirmed activity after selection", async () => {
    harness.authFetch.mockImplementation(async (url: string) => {
      if (url === "/api/sessions/active-streams") {
        return response({ sessions: [{ sessionId: "session-running", active: true, runId: "run-shared" }] });
      }
      if (url.endsWith("/stream-status")) return response({ active: false });
      return response({}, 404);
    });
    const { result } = renderHook(() => useChatAppState());

    await act(async () => {
      harness.sessionCallbacks?.onSessionsLoaded?.([{ sessionId: "session-running" }]);
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => result.current.selectSession("session-running"));
    await act(async () => {
      harness.sessionCallbacks?.onLastRunState?.("session-running", { status: "completed", runId: "run-shared" });
      await Promise.resolve();
    });

    expect(result.current.runningSessionIds.has("session-running")).toBe(true);
    expect(result.current.sessionRuntimeStatuses.get("session-running")).toBe("running");
  });

  it("keeps a WS-confirmed runtime through active and inactive snapshots, then clears it on terminal", async () => {
    vi.useFakeTimers();
    harness.session.sessionId = "session-sleeping";
    harness.session.isNewSession = false;
    const active = [true, false];
    harness.authFetch.mockImplementation(async (url: string) => {
      if (url === "/api/sessions/active-streams") {
        return response({ sessions: [{ sessionId: "session-sleeping", active: active.shift(), streamId: "stream-sleeping", runId: "run-sleeping" }] });
      }
      if (url.endsWith("/stream-status")) return response({ active: false });
      return response({}, 404);
    });
    const { result } = renderHook(() => useChatAppState());

    act(() => emit({ type: "session_status", sessionId: "session-sleeping", status: "running", streamId: "stream-sleeping", runId: "run-sleeping" }));
    await act(async () => {
      harness.sessionCallbacks?.onSessionsLoaded?.([{ sessionId: "session-sleeping" }]);
      await Promise.resolve(); await Promise.resolve();
      harness.sessionCallbacks?.onSessionsLoaded?.([{ sessionId: "session-sleeping" }]);
      await Promise.resolve(); await Promise.resolve();
    });
    expect(result.current.runningSessionIds.has("session-sleeping")).toBe(true);
    act(() => emit({ type: "session_status", sessionId: "session-sleeping", status: "completed", runId: "run-sleeping" }));
    expect(result.current.runningSessionIds.has("session-sleeping")).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(750);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.runningSessionIds.has("session-sleeping")).toBe(false);
  });

  it("clears a snapshot-only runtime when a later snapshot is inactive", async () => {
    harness.session.sessionId = "session-finished";
    harness.session.isNewSession = false;
    const active = [true, false];
    harness.authFetch.mockImplementation(async (url: string) => url === "/api/sessions/active-streams"
      ? response({ sessions: [{ sessionId: "session-finished", active: active.shift() }] }) : response({}, 404));
    const { result } = renderHook(() => useChatAppState());

    await act(async () => {
      harness.sessionCallbacks?.onSessionsLoaded?.([{ sessionId: "session-finished" }]);
      await Promise.resolve(); await Promise.resolve();
    });
    expect(result.current.runningSessionIds.has("session-finished")).toBe(true);
    await act(async () => {
      harness.sessionCallbacks?.onSessionsLoaded?.([{ sessionId: "session-finished" }]);
      await Promise.resolve(); await Promise.resolve();
    });
    expect(result.current.runningSessionIds.has("session-finished")).toBe(false);
  });

  it("assigns an authoritative new session to the pending group", async () => {
    const { result } = renderHook(() => useChatAppState());

    act(() => result.current.newSession("group-1"));
    act(() => result.current.setInput("grouped conversation"));
    await act(async () => { await result.current.sendMessage(); });
    act(() => emit({
      type: "session",
      sessionId: "session-grouped",
      client_msg_id: chatPayloads()[0].submission.clientMsgId,
    }));

    expect(harness.assignPendingGroup).toHaveBeenCalledWith("session-grouped");
  });

  it("keeps failed ACK and cancelled authoritative lookup out of sent projection", async () => {
    vi.useFakeTimers();
    const cancelledId = "00000000-0000-4000-8000-000000000003";
    harness.authFetch.mockImplementation(async (url: string) => {
      if (url.includes(`/api/messages/${cancelledId}/status`)) {
        return response({
          status: "cancelled",
          runId: "run-cancelled",
          sessionId: "session-authoritative",
          deliveryMode: "queue",
          reason: "cancelled by policy",
        });
      }
      return response({}, 404);
    });
    const { result } = renderHook(() => useChatAppState());

    act(() => result.current.setInput("first"));
    await act(async () => { await result.current.sendMessage(); });
    const firstId = chatPayloads()[0].submission.clientMsgId;
    act(() => emit({ type: "session", sessionId: "session-authoritative", client_msg_id: firstId }));
    act(() => emit({ type: "chat_ack", client_msg_id: firstId, server_recv_ts: 1, status: "running", sessionId: "session-authoritative" }));

    act(() => result.current.setInput("will fail"));
    await act(async () => { await result.current.sendMessage(); });
    const failedId = chatPayloads()[1].submission.clientMsgId as string;
    act(() => emit({ type: "chat_ack", client_msg_id: failedId, server_recv_ts: 2, status: "failed", runId: "run-failed", sessionId: "session-authoritative" }));

    act(() => result.current.setInput("will cancel"));
    await act(async () => { await result.current.sendMessage(); });
    expect(chatPayloads()[2].submission.clientMsgId).toBe(cancelledId);
    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.queuedInterjections.find((entry) => entry.clientMsgId === failedId)?.status).toBe("failed");
    expect(result.current.queuedInterjections.find((entry) => entry.clientMsgId === cancelledId)?.status).toBe("cancelled");
    expect(result.current.messages.some((message) => (
      message.type === "user"
      && (message.clientMsgId === failedId || message.clientMsgId === cancelledId)
      && message.status === "sent"
    ))).toBe(false);
  });

  it("does not project a delayed authoritative lookup into a different session", async () => {
    vi.useFakeTimers();
    const deferredId = "00000000-0000-4000-8000-000000000002";
    harness.authFetch.mockImplementation(async (url: string) => {
      if (url.includes(`/api/messages/${deferredId}/status`)) {
        return response({
          status: "queued",
          runId: "run-a-queued",
          sessionId: "session-a",
          deliveryMode: "queue",
          queuePosition: 1,
        });
      }
      return response({}, 404);
    });
    const { result } = renderHook(() => useChatAppState());

    act(() => result.current.setInput("root-a"));
    await act(async () => { await result.current.sendMessage(); });
    act(() => result.current.setInput("queued-a"));
    await act(async () => { await result.current.sendMessage(); });
    const rootId = chatPayloads()[0].submission.clientMsgId;
    act(() => emit({ type: "session", sessionId: "session-a", client_msg_id: rootId }));
    await act(async () => { await result.current.sendMessage(); });
    expect(chatPayloads()).toHaveLength(2);
    act(() => emit({ type: "chat_ack", client_msg_id: rootId, status: "running", sessionId: "session-a" }));

    harness.session.selectSession.mockImplementationOnce(() => {
      harness.sessionCallbacks?.cancelActiveStream?.();
    });
    act(() => result.current.selectSession("session-b"));
    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(harness.authFetch).toHaveBeenCalledWith(`/api/messages/${deferredId}/status`, undefined);
    expect(result.current.queuedInterjections.some((entry) => entry.content === "queued-a")).toBe(false);

    act(() => result.current.selectSession("session-a"));
    expect(result.current.queuedInterjections.find((entry) => entry.clientMsgId === deferredId)).toMatchObject({
      sessionId: "session-a",
      status: "queued",
      sourceRunId: "run-a-queued",
    });
  });

  it("keeps an offscreen not-found submission as failed so returning to the session can retry", async () => {
    vi.useFakeTimers();
    const queuedId = "00000000-0000-4000-8000-000000000002";
    const { result } = renderHook(() => useChatAppState());

    act(() => result.current.setInput("first"));
    await act(async () => { await result.current.sendMessage(); });
    const firstId = chatPayloads()[0].submission.clientMsgId;
    act(() => emit({ type: "session", sessionId: "session-a", client_msg_id: firstId }));
    act(() => emit({ type: "chat_ack", client_msg_id: firstId, status: "running", sessionId: "session-a" }));
    act(() => result.current.setInput("not received"));
    await act(async () => { await result.current.sendMessage(); });

    harness.session.selectSession.mockImplementationOnce(() => {
      harness.sessionCallbacks?.cancelActiveStream?.();
    });
    act(() => result.current.selectSession("session-b"));
    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.queuedInterjections.some((entry) => entry.clientMsgId === queuedId)).toBe(false);

    act(() => result.current.selectSession("session-a"));
    expect(result.current.queuedInterjections.find((entry) => entry.clientMsgId === queuedId)).toMatchObject({
      sessionId: "session-a",
      status: "failed",
      reason: "服务端未收到该消息，请重试",
    });
  });

  it("keeps a later submission verification alive when the current run becomes terminal", async () => {
    vi.useFakeTimers();
    const queuedId = "00000000-0000-4000-8000-000000000002";
    harness.authFetch.mockImplementation(async (url: string) => {
      if (url.includes(`/api/messages/${queuedId}/status`)) {
        return response({
          status: "queued",
          runId: "queued-after-terminal",
          sessionId: "session-authoritative",
          deliveryMode: "queue",
          queuePosition: 1,
        });
      }
      return response({}, 404);
    });
    const { result } = renderHook(() => useChatAppState());

    act(() => result.current.setInput("first"));
    await act(async () => { await result.current.sendMessage(); });
    const firstId = chatPayloads()[0].submission.clientMsgId;
    act(() => emit({ type: "session", sessionId: "session-authoritative", client_msg_id: firstId }));
    act(() => emit({ type: "chat_ack", client_msg_id: firstId, status: "running", runId: "run-first", sessionId: "session-authoritative" }));

    act(() => result.current.setInput("queued after terminal"));
    await act(async () => { await result.current.sendMessage(); });
    act(() => emit({ type: "session_status", sessionId: "session-authoritative", runId: "run-first", status: "completed" }));
    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(harness.authFetch).toHaveBeenCalledWith(`/api/messages/${queuedId}/status`, undefined);
    expect(result.current.queuedInterjections.find((entry) => entry.clientMsgId === queuedId)).toMatchObject({
      status: "queued",
      sourceRunId: "queued-after-terminal",
    });
  });

  it("uses a refreshed attachmentId-only snapshot as authority without local resend", async () => {
    const { result } = renderHook(() => useChatAppState());
    act(() => result.current.setInput("first"));
    await act(async () => { await result.current.sendMessage(); });
    const firstId = chatPayloads()[0].submission.clientMsgId;
    act(() => emit({ type: "session", sessionId: "session-authoritative", client_msg_id: firstId }));
    act(() => harness.sessionCallbacks?.onQueueSnapshot?.("session-authoritative", {
      version: 1,
      sessionId: "session-authoritative",
      generatedAt: "2026-08-15T01:00:00.000Z",
      items: [{
        sessionId: "session-authoritative", sourceRunId: "queued-snapshot", runId: "queued-snapshot",
        clientMsgId: "client-snapshot", deliveryMode: "queue", status: "queued", content: "snapshot attachment",
        attachments: [{ attachmentId: fileB.attachmentId, name: fileB.originalName }],
      }],
    }));
    expect(result.current.queuedInterjections[0]).toMatchObject({
      clientMsgId: "client-snapshot",
      attachments: [{ attachmentId: fileB.attachmentId, name: fileB.originalName }],
    });
    expect(chatPayloads()).toHaveLength(1);
  });

  it("preserves full UploadedFile data through queued edit and resend", async () => {
    const { result, rerender } = renderHook(() => useChatAppState());

    act(() => result.current.setInput("first"));
    await act(async () => { await result.current.sendMessage(); });
    const firstId = chatPayloads()[0].submission.clientMsgId;
    act(() => emit({ type: "session", sessionId: "session-authoritative", client_msg_id: firstId }));
    act(() => emit({ type: "chat_ack", client_msg_id: firstId, server_recv_ts: 1, status: "running", sessionId: "session-authoritative" }));

    harness.currentFiles = [fileA];
    rerender();
    act(() => result.current.setInput("edit me"));
    await act(async () => { await result.current.sendMessage(); });
    const editId = chatPayloads()[1].submission.clientMsgId as string;

    harness.currentFiles = [fileB];
    rerender();
    act(() => result.current.setInput("resend me"));
    await act(async () => { await result.current.sendMessage(); });
    const resendId = chatPayloads()[2].submission.clientMsgId as string;

    act(() => {
      emit({ type: "chat_ack", client_msg_id: editId, server_recv_ts: 2, status: "failed", runId: "run-edit" });
      emit({ type: "chat_ack", client_msg_id: resendId, server_recv_ts: 3, status: "failed", runId: "run-resend" });
    });

    await act(async () => { await result.current.editQueuedInterjection(editId); });
    expect(result.current.input).toBe("edit me");
    expect(harness.replaceFiles).toHaveBeenLastCalledWith([fileA]);

    act(() => result.current.resendQueuedInterjection(resendId));
    await waitFor(() => expect(chatPayloads()).toHaveLength(4));
    expect(chatPayloads()[3].submission.attachments).toEqual([{
      attachmentId: fileB.attachmentId,
      display: {
        originalName: fileB.originalName,
        size: fileB.size,
        mimeType: fileB.mimeType,
        isImage: fileB.isImage,
      },
    }]);
    expect(JSON.stringify(chatPayloads()[3])).not.toMatch(/savedPath|relativePath|\/uploads\//);
  });

  it("handles a rejected permission response without surfacing an unhandled rejection", async () => {
    harness.session.sessionId = "session-permission";
    harness.session.isNewSession = false;
    const { result } = renderHook(() => useChatAppState());

    const pending = result.current.handlePermissionResponse("permission-1", true);
    await waitFor(() => expect(harness.sends).toHaveBeenCalledWith(expect.objectContaining({
      action: "respond", interactionId: "permission-1",
    })));
    act(() => emit({ type: "respond_error", interactionId: "permission-1", error: "Run unavailable" }));
    await act(async () => { await pending; });
  });
});
