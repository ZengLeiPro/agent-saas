// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAppState } from './useChatAppState';
import type { MessageItem, SessionListActiveInteraction } from '@agent/shared';

const h = vi.hoisted(() => {
  const messages: MessageItem[] = [];
  const session = {
    sessionId: 'session-a',
    sessions: [{ sessionId: 'session-a' }, { sessionId: 'session-b' }],
    sessionOwner: undefined,
    tokenUsage: null,
    contextUsage: null,
    hasMore: false,
    isLoadingMore: false,
    isLoadingSessions: false,
    sessionsHydrated: true,
    isLoadingMessages: false,
    hasMoreHistory: false,
    isLoadingEarlier: false,
    loadEarlierMessages: vi.fn(async () => undefined),
    loadMoreSessions: vi.fn(async () => undefined),
    loadSessions: vi.fn(async () => undefined),
    refreshCurrentSession: vi.fn(),
    refreshTokenUsage: vi.fn(),
    selectSession: vi.fn(),
    newSession: vi.fn(),
    markSessionRead: vi.fn(async () => undefined),
    confirmDeleteSession: vi.fn(),
    cancelDeleteSession: vi.fn(),
    handleDeleteSession: vi.fn(async () => undefined),
    renameSession: vi.fn(async () => true),
    autoTitleSession: vi.fn(async () => true),
    deleteSessionId: null,
    applySessionInteractionEvent: vi.fn(),
    getActiveInteraction: vi.fn<(sessionId: string) => SessionListActiveInteraction | undefined>(() => undefined),
    updateSessionTitle: vi.fn(),
    updateSessionMeta: vi.fn(),
    removeSession: vi.fn(),
    upsertSession: vi.fn(),
    setContextUsage: vi.fn(),
    loadDetailPromiseRef: { current: Promise.resolve() },
  };
  return {
    listener: null as null | ((envelope: { data: any }) => void),
    latest: null as ChatAppState | null,
    messages,
    session,
    addMessage: vi.fn((message: MessageItem) => messages.push(message)),
    resetMessages: vi.fn(() => { messages.length = 0; }),
    wsSend: vi.fn(),
    ensureConnectedSend: vi.fn(async () => true),
    dispatchConnection: vi.fn(),
  };
});

vi.mock('@agent/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/shared')>();
  return {
    ...actual,
    authFetch: vi.fn(async () => ({ ok: false, json: async () => null })),
    fetchAgentProfile: vi.fn(async () => null),
    getPlatform: () => ({ storage: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined), removeItem: vi.fn(async () => undefined) }, messageCache: { save: vi.fn(async () => undefined) } }),
    useConnectionState: () => ({ connectionState: 'disconnected', dispatchConnection: h.dispatchConnection }),
    wsClient: {
      currentState: 'disconnected',
      acquire: vi.fn(async () => vi.fn()),
      onMessage: vi.fn((listener: (envelope: { data: any }) => void) => { h.listener = listener; return vi.fn(); }),
      onStateChange: vi.fn(() => vi.fn()),
      send: h.wsSend,
      ensureConnectedSend: h.ensureConnectedSend,
      setLastSeq: vi.fn(),
      setSyncSessionId: vi.fn(),
    },
  };
});
vi.mock('./useMessages', () => ({ useMessages: () => ({
  messages: h.messages,
  messagesRef: { current: h.messages },
  addMessage: h.addMessage,
  setMessages: vi.fn((next: MessageItem[]) => { h.messages.splice(0, h.messages.length, ...next); }),
  resetMessages: h.resetMessages,
  updateMessageAt: vi.fn((index: number, update: (message: MessageItem) => MessageItem) => {
    h.messages[index] = update(h.messages[index]);
  }),
  triggerScroll: vi.fn(),
  shouldScrollRef: { current: false }, isNearBottomRef: { current: true },
}) }));
vi.mock('./useSession', () => ({ useSession: (callbacks: { cancelActiveStream: () => void; clearComposer: () => void; resetMessages: () => void }) => {
  h.session.selectSession.mockImplementation(() => {
    callbacks.cancelActiveStream();
    callbacks.clearComposer();
    callbacks.resetMessages();
  });
  return h.session;
} }));
vi.mock('./useFileUpload', () => ({ useFileUpload: () => ({
  uploadedFiles: [], uploading: false, uploadError: null,
  dismissUploadError: vi.fn(), pickFile: vi.fn(), pickImage: vi.fn(), takePhoto: vi.fn(),
  removeFile: vi.fn(), clearFiles: vi.fn(), consumeFiles: vi.fn(() => []), addUploadedFiles: vi.fn(), reportUploadError: vi.fn(),
}) }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: null, identity: null }) }));
vi.mock('../contexts/LocalAppLockContext', () => ({ useLocalAppLock: () => ({ locked: false, offlineShell: false }) }));
vi.mock('../telemetry/runtime', () => ({ telemetryClient: () => null }));
vi.mock('../telemetry/chatTelemetry', () => ({ markChatAck: vi.fn(), markChatSubmit: vi.fn(), observeChatEvent: vi.fn() }));
vi.mock('expo-file-system', () => ({ File: class File {} }));

import { useChatAppStateCore } from './useChatAppState';

function Harness() { h.latest = useChatAppStateCore(); return null; }
const emit = (data: any) => h.listener?.({ data });

beforeEach(() => {
  h.messages.length = 0;
  h.latest = null;
  h.listener = null;
  vi.clearAllMocks();
  h.session.getActiveInteraction.mockReturnValue(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); cleanup(); });

describe('useChatAppState 会话切换窗口的事件归属', () => {
  it('真实 detach 后仍把延迟 legacy ask/permission 记入 A，不污染刚选中的 B', () => {
    render(<Harness />);
    act(() => emit({ type: 'stream_started', sessionId: 'session-a', streamId: 'stream-a', runId: 'run-a' }));
    vi.clearAllMocks();

    act(() => {
      h.latest!.selectSession('session-b');
      emit({ type: 'ask_user', interactionId: 'ask-a', questions: [] });
      emit({ type: 'permission_request', interactionId: 'permission-a', toolName: 'Shell', toolInput: {} });
    });

    expect(h.wsSend).toHaveBeenCalledWith({ action: 'detach' });
    expect(h.resetMessages).toHaveBeenCalledOnce();
    expect(h.session.applySessionInteractionEvent).toHaveBeenCalledTimes(2);
    expect(h.session.applySessionInteractionEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: 'requested', sessionId: 'session-a' }));
    expect(h.session.applySessionInteractionEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({ type: 'requested', sessionId: 'session-a' }));
    expect(h.addMessage).not.toHaveBeenCalled();
    expect(h.messages).toEqual([]);
  });

  it('拒绝 A 的 terminal、sync_ok 与 sync_overflow 改写刚选中的 B 当前视图', () => {
    render(<Harness />);
    act(() => emit({ type: 'stream_started', sessionId: 'session-a', streamId: 'stream-a', runId: 'run-a' }));
    expect(h.latest!.loading).toBe(true);
    vi.clearAllMocks();

    act(() => {
      h.latest!.selectSession('session-b');
      emit({ type: 'session_status', sessionId: 'session-a', runId: 'run-a', status: 'failed', reason: 'A failed' });
      emit({ type: 'sync_ok', seq: 9, events: [{ event: { type: 'session_status', sessionId: 'session-a', runId: 'run-a', status: 'failed', reason: 'A failed again' } }] });
      emit({ type: 'sync_overflow', seq: 10, recovery: { version: 1, authoritative: true, refresh: {}, session: { sessionId: 'session-a', runtime: { runId: 'run-a', streamId: 'stream-a', active: false } } } });
    });

    expect(h.latest!.loading).toBe(false);
    expect(h.addMessage).not.toHaveBeenCalled();
    expect(h.session.refreshCurrentSession).not.toHaveBeenCalled();
    expect(h.dispatchConnection).not.toHaveBeenCalledWith('complete');
  });

  it('detach 归属过期后丢弃无 sessionId 的旧协议 interaction', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    render(<Harness />);
    act(() => emit({ type: 'stream_started', sessionId: 'session-a', streamId: 'stream-a', runId: 'run-a' }));
    act(() => h.latest!.selectSession('session-b'));
    vi.clearAllMocks();

    now.mockReturnValue(31_001);
    act(() => emit({ type: 'ask_user', interactionId: 'late-ask-a', questions: [] }));

    expect(h.session.applySessionInteractionEvent).not.toHaveBeenCalled();
    expect(h.addMessage).not.toHaveBeenCalled();
  });

  it('terminal tombstone prevents a late request from restoring the sidebar interaction', () => {
    render(<Harness />);
    act(() => emit({ type: 'stream_started', sessionId: 'session-a', streamId: 'stream-a', runId: 'run-a' }));
    act(() => emit({
      type: 'ask_user', interactionId: 'ask-late', version: 1, order: 1,
      questions: [{ question: 'q', header: 'h', options: [], multiSelect: false }],
    }));
    vi.clearAllMocks();

    act(() => {
      emit({
        type: 'interaction_resolved', sessionId: 'session-a', interactionId: 'ask-late',
        status: 'resolved', response: { answers: { q: 'done' } },
      });
      emit({ type: 'ask_user', interactionId: 'ask-late', version: 1, order: 1, questions: [] });
    });

    expect(h.session.applySessionInteractionEvent).toHaveBeenCalledOnce();
    expect(h.session.applySessionInteractionEvent).toHaveBeenCalledWith({
      type: 'resolved', sessionId: 'session-a', interactionId: 'ask-late',
    });
    expect(h.messages.filter((message) => message.type === 'ask_user')).toEqual([
      expect.objectContaining({ interactionId: 'ask-late', status: 'answered', answers: { q: 'done' } }),
    ]);
    expect(h.addMessage).not.toHaveBeenCalled();
  });

  it('ignores a non-canonical empty resolved frame instead of hiding a later request', () => {
    render(<Harness />);
    act(() => emit({ type: 'stream_started', sessionId: 'session-a', streamId: 'stream-a', runId: 'run-a' }));
    vi.clearAllMocks();

    act(() => {
      emit({ type: 'interaction_resolved', sessionId: 'session-a', interactionId: 'ask-real' });
      emit({ type: 'ask_user', interactionId: 'ask-real', version: 1, order: 1, questions: [] });
    });

    expect(h.session.applySessionInteractionEvent).toHaveBeenCalledOnce();
    expect(h.session.applySessionInteractionEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'requested', sessionId: 'session-a', interaction: expect.objectContaining({ interactionId: 'ask-real' }),
    }));
  });

  it('terminal respond ACK collapses duplicate cards and clears the waiting status', async () => {
    render(<Harness />);
    act(() => emit({ type: 'stream_started', sessionId: 'session-a', streamId: 'stream-a', runId: 'run-a' }));
    act(() => emit({
      type: 'ask_user', interactionId: 'ask-ack', version: 1, order: 1,
      questions: [{ question: 'q', header: 'h', options: [], multiSelect: false }],
    }));
    h.messages.push({
      id: 'duplicate-ask', type: 'ask_user', interactionId: 'ask-ack', interactionVersion: 1,
      questions: [{ question: 'q', header: 'h', options: [], multiSelect: false }], status: 'pending',
    });

    await act(async () => h.latest!.handleAskUserResponse('ask-ack', { q: 'A' }));
    act(() => emit({
      type: 'respond_ok', interactionId: 'ask-ack', status: 'resolved', response: { answers: { q: 'A' } },
    }));

    expect(h.messages.filter((message) => message.type === 'ask_user' && message.interactionId === 'ask-ack'))
      .toEqual([expect.objectContaining({ status: 'answered', answers: { q: 'A' } })]);
    expect(h.messages.some((message) => message.type === 'runtime_status' && message.status === 'waiting_user')).toBe(false);
  });

  it('accepted ACK丢失后续终态时会超时释放提交锁', async () => {
    vi.useFakeTimers();
    render(<Harness />);
    act(() => emit({ type: 'stream_started', sessionId: 'session-a', streamId: 'stream-a', runId: 'run-a' }));
    act(() => emit({
      type: 'ask_user', interactionId: 'ask-accepted', version: 1, order: 1,
      questions: [{ question: 'q', header: 'h', options: [], multiSelect: false }],
    }));
    h.ensureConnectedSend.mockClear();

    await act(async () => h.latest!.handleAskUserResponse('ask-accepted', { q: 'A' }));
    act(() => emit({ type: 'respond_ok', interactionId: 'ask-accepted', status: 'accepted' }));
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    await act(async () => h.latest!.handleAskUserResponse('ask-accepted', { q: 'A' }));

    expect(h.ensureConnectedSend).toHaveBeenCalledTimes(2);
  });

});
