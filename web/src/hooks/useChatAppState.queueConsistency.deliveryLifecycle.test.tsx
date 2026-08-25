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
    pendingOrgAgentIdRef: { current: null as string | null },
    pendingNewSessionGroupIdRef: { current: null as string | null },
    assignPendingGroup: vi.fn(),
    currentFiles: [] as UploadedFile[],
    replaceFiles: vi.fn((files: UploadedFile[]) => {
      harness.currentFiles = files;
    }),
    sessionCallbacks: null as null | {
      onSessionsLoaded?: (sessions: Array<{ sessionId: string }>) => void;
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

const fileA: UploadedFile = {
  attachmentId: "att-a",
  originalName: "a.png",
  savedPath: "/uploads/a.png",
  relativePath: "uploads/a.png",
  size: 123,
  mimeType: "image/png",
  isImage: true,
};
const fileB: UploadedFile = {
  attachmentId: "att-b",
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
  harness.authFetch.mockReset().mockResolvedValue(response({}, 404));
  let id = 0;
  vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useChatAppState queue delivery lifecycle", () => {
  it("keeps a WS-confirmed session running when a later list snapshot is temporarily inactive", async () => {
    harness.session.sessionId = "session-sleeping";
    harness.session.isNewSession = false;
    harness.authFetch.mockImplementation(async (url: string) => url === "/api/sessions/active-streams"
      ? response({ sessions: [{ sessionId: "session-sleeping", active: false }] }) : response({}, 404));
    const { result } = renderHook(() => useChatAppState());

    act(() => emit({ type: "session_status", sessionId: "session-sleeping", status: "running", streamId: "stream-sleeping", runId: "run-sleeping" }));
    expect(result.current.runningSessionIds.has("session-sleeping")).toBe(true);
    await act(async () => {
      harness.sessionCallbacks?.onSessionsLoaded?.([{ sessionId: "session-sleeping" }]);
      await Promise.resolve(); await Promise.resolve();
    });
    await waitFor(() => expect(harness.authFetch).toHaveBeenCalledWith("/api/sessions/active-streams", expect.objectContaining({ method: "POST" })));
    expect(result.current.runningSessionIds.has("session-sleeping")).toBe(true);
    expect(result.current.sessionRuntimeStatuses.get("session-sleeping")).toBe("running");
  });

  it("assigns an authoritative new session to the pending group", async () => {
    const { result } = renderHook(() => useChatAppState());

    act(() => result.current.newSession("group-1"));
    act(() => result.current.setInput("grouped conversation"));
    await act(async () => { await result.current.sendMessage(); });
    act(() => emit({
      type: "session",
      sessionId: "session-grouped",
      client_msg_id: chatPayloads()[0].client_msg_id,
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
    const firstId = chatPayloads()[0].client_msg_id;
    act(() => emit({ type: "session", sessionId: "session-authoritative", client_msg_id: firstId }));
    act(() => emit({ type: "chat_ack", client_msg_id: firstId, server_recv_ts: 1, status: "running", sessionId: "session-authoritative" }));

    act(() => result.current.setInput("will fail"));
    await act(async () => { await result.current.sendMessage(); });
    const failedId = chatPayloads()[1].client_msg_id as string;
    act(() => emit({ type: "chat_ack", client_msg_id: failedId, server_recv_ts: 2, status: "failed", runId: "run-failed", sessionId: "session-authoritative" }));

    act(() => result.current.setInput("will cancel"));
    await act(async () => { await result.current.sendMessage(); });
    expect(chatPayloads()[2].client_msg_id).toBe(cancelledId);
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
    const rootId = chatPayloads()[0].client_msg_id;
    act(() => emit({ type: "session", sessionId: "session-a", client_msg_id: rootId }));
    await act(async () => { await Promise.resolve(); });
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
    const firstId = chatPayloads()[0].client_msg_id;
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
    const firstId = chatPayloads()[0].client_msg_id;
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

  it("restores full attachment references from a refreshed snapshot for edit and resend", async () => {
    const { result } = renderHook(() => useChatAppState());

    act(() => result.current.setInput("first"));
    await act(async () => { await result.current.sendMessage(); });
    const firstId = chatPayloads()[0].client_msg_id;
    act(() => emit({ type: "session", sessionId: "session-authoritative", client_msg_id: firstId }));
    act(() => emit({ type: "chat_ack", client_msg_id: firstId, status: "running", runId: "run-first", sessionId: "session-authoritative" }));

    const snapshotMessage = {
      sourceRunId: "queued-snapshot",
      runId: "queued-snapshot",
      clientMsgId: "client-snapshot",
      deliveryMode: "queue" as const,
      content: "snapshot attachment",
      acceptedAt: "2026-08-15T01:00:00.000Z",
      attachments: [{
        attachmentId: fileB.attachmentId,
        name: fileB.originalName,
        savedPath: fileB.savedPath,
        relativePath: fileB.relativePath,
        size: fileB.size,
        mimeType: fileB.mimeType,
        isImage: fileB.isImage,
      }],
    };
    act(() => harness.sessionCallbacks?.onQueuedMessages?.("session-authoritative", [snapshotMessage]));
    expect(result.current.queuedInterjections[0]?.uploadedFiles).toEqual([fileB]);

    let editPromise: Promise<void> | undefined;
    act(() => { editPromise = result.current.editQueuedInterjection("client-snapshot"); });
    await waitFor(() => expect(harness.sends).toHaveBeenCalledWith({ action: "cancel_queued", sourceRunId: "queued-snapshot" }));
    act(() => emit({ type: "cancel_queued_result", ok: true, sourceRunId: "queued-snapshot" }));
    await act(async () => { await editPromise; });
    expect(harness.replaceFiles).toHaveBeenLastCalledWith([fileB]);

    act(() => harness.sessionCallbacks?.onQueuedMessages?.("session-authoritative", [snapshotMessage]));
    act(() => emit({
      type: "steering_cancelled",
      sessionId: "session-authoritative",
      sourceRunId: "queued-snapshot",
      clientMsgId: "client-snapshot",
      reason: "user_withdrew",
    }));
    act(() => result.current.resendQueuedInterjection("client-snapshot"));
    await waitFor(() => expect(chatPayloads()).toHaveLength(2));
    expect(chatPayloads()[1].attachments).toEqual([{
      attachmentId: fileB.attachmentId,
      originalName: fileB.originalName,
      savedPath: fileB.savedPath,
      relativePath: fileB.relativePath,
      size: fileB.size,
      mimeType: fileB.mimeType,
      isImage: fileB.isImage,
    }]);
  });

  it("preserves full UploadedFile data through queued edit and resend", async () => {
    const { result, rerender } = renderHook(() => useChatAppState());

    act(() => result.current.setInput("first"));
    await act(async () => { await result.current.sendMessage(); });
    const firstId = chatPayloads()[0].client_msg_id;
    act(() => emit({ type: "session", sessionId: "session-authoritative", client_msg_id: firstId }));
    act(() => emit({ type: "chat_ack", client_msg_id: firstId, server_recv_ts: 1, status: "running", sessionId: "session-authoritative" }));

    harness.currentFiles = [fileA];
    rerender();
    act(() => result.current.setInput("edit me"));
    await act(async () => { await result.current.sendMessage(); });
    const editId = chatPayloads()[1].client_msg_id as string;

    harness.currentFiles = [fileB];
    rerender();
    act(() => result.current.setInput("resend me"));
    await act(async () => { await result.current.sendMessage(); });
    const resendId = chatPayloads()[2].client_msg_id as string;

    act(() => {
      emit({ type: "chat_ack", client_msg_id: editId, server_recv_ts: 2, status: "failed", runId: "run-edit" });
      emit({ type: "chat_ack", client_msg_id: resendId, server_recv_ts: 3, status: "failed", runId: "run-resend" });
    });

    await act(async () => { await result.current.editQueuedInterjection(editId); });
    expect(result.current.input).toBe("edit me");
    expect(harness.replaceFiles).toHaveBeenLastCalledWith([fileA]);

    act(() => result.current.resendQueuedInterjection(resendId));
    await waitFor(() => expect(chatPayloads()).toHaveLength(4));
    expect(chatPayloads()[3].attachments).toEqual([{
      attachmentId: fileB.attachmentId,
      originalName: fileB.originalName,
      savedPath: fileB.savedPath,
      relativePath: fileB.relativePath,
      size: fileB.size,
      mimeType: fileB.mimeType,
      isImage: fileB.isImage,
    }]);
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
    await waitFor(() => expect(result.current.notifications).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "Run unavailable", priority: "high" }),
    ])));
  });
});
