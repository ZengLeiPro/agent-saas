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

function interactionPayloads(): Array<Record<string, unknown>> {
  return harness.sends.mock.calls
    .map(([payload]) => payload as Record<string, unknown>)
    .filter((payload) => payload.action === "respond");
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

describe("useChatAppState ACK lifecycle", () => {
  it("releases a sent interaction after transport drop, ignores its old ACK, and accepts the retry ACK", async () => {
    const { result } = renderHook(() => useChatAppState());
    const answers = { "Choose a path": "Continue" };

    act(() => emit({
      type: "pending_interactions",
      interactions: [{
        type: "ask_user",
        interactionId: "ask-retry",
        questions: [{
          question: "Choose a path",
          header: "Path",
          options: [{ label: "Continue", description: "Proceed" }],
          multiSelect: false,
        }],
      }],
    }));

    await act(async () => { await result.current.handleAskUserResponse("ask-retry", answers); });
    expect(interactionPayloads()).toHaveLength(1);
    const oldAttemptId = interactionPayloads()[0].clientAttemptId as string;

    await act(async () => {
      for (const handler of [...harness.stateHandlers]) handler("reconnecting");
      await Promise.resolve();
    });

    await act(async () => { await result.current.handleAskUserResponse("ask-retry", answers); });
    expect(interactionPayloads()).toHaveLength(2);
    const latestAttemptId = interactionPayloads()[1].clientAttemptId as string;
    expect(latestAttemptId).not.toBe(oldAttemptId);

    act(() => emit({ type: "respond_ok", interactionId: "ask-retry", clientAttemptId: oldAttemptId }));
    // The old ACK leaves the latest in-flight generation owned, so duplicate
    // submit is still idempotently blocked.
    await act(async () => { await result.current.handleAskUserResponse("ask-retry", answers); });
    expect(interactionPayloads()).toHaveLength(2);

    act(() => emit({ type: "respond_ok", interactionId: "ask-retry", clientAttemptId: latestAttemptId }));
    await act(async () => { await result.current.handleAskUserResponse("ask-retry", answers); });
    expect(interactionPayloads()).toHaveLength(3);
  });

  it("applies the canonical first response when its ACK was lost and the retry changed the answer", async () => {
    const { result } = renderHook(() => useChatAppState());
    act(() => emit({
      type: "pending_interactions",
      interactions: [{
        type: "permission_request",
        interactionId: "approval-canonical",
        toolName: "Shell",
        toolInput: { command: "echo test" },
      }],
    }));

    await act(async () => { await result.current.handlePermissionResponse("approval-canonical", true); });
    await act(async () => {
      for (const handler of [...harness.stateHandlers]) handler("reconnecting");
      await Promise.resolve();
    });
    await act(async () => { await result.current.handlePermissionResponse("approval-canonical", false); });
    const retryAttemptId = interactionPayloads()[1].clientAttemptId as string;

    act(() => emit({
      type: "respond_ok",
      interactionId: "approval-canonical",
      clientAttemptId: retryAttemptId,
      response: { allow: true, message: "first response was persisted" },
    }));

    await waitFor(() => expect(result.current.messages.find((message) => "interactionId" in message && message.interactionId === "approval-canonical"))
      .toMatchObject({ type: "permission_request", status: "allowed" }));
  });

  it.each([
    ["approval-remote-allow", true, "allowed"],
    ["approval-remote-deny", false, "denied"],
  ] as const)("applies cross-connection canonical approval %s", async (interactionId, allow, status) => {
    const { result } = renderHook(() => useChatAppState());
    act(() => emit({ type: "pending_interactions", interactions: [{
      type: "permission_request", interactionId, toolName: "Shell", toolInput: { command: "echo test" },
    }] }));
    act(() => emit({ type: "interaction_resolved", sessionId: "session-remote", interactionId, response: { allow } }));
    await waitFor(() => expect(result.current.messages.find((message) => "interactionId" in message && message.interactionId === interactionId))
      .toMatchObject({ type: "permission_request", status }));
  });

  it("applies cross-connection canonical AskUser answer after a lost ACK and changed retry", async () => {
    const { result } = renderHook(() => useChatAppState());
    act(() => emit({ type: "pending_interactions", interactions: [{
      type: "ask_user", interactionId: "ask-remote", questions: [{ question: "q", header: "h", options: [], multiSelect: false }],
    }] }));
    act(() => emit({
      type: "interaction_resolved", sessionId: "session-remote", interactionId: "ask-remote",
      response: { answers: { q: "canonical-first-answer" } },
    }));
    await waitFor(() => expect(result.current.messages.find((message) => "interactionId" in message && message.interactionId === "ask-remote"))
      .toMatchObject({ type: "ask_user", status: "answered", answers: { q: "canonical-first-answer" } }));
  });
});
