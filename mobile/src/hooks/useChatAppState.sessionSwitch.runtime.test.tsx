// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatAppState } from './useChatAppState';

const h = vi.hoisted(() => {
  const messages: unknown[] = [];
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
    addMessage: vi.fn((message: unknown) => messages.push(message)),
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
      send: vi.fn(),
      ensureConnectedSend: vi.fn(async () => true),
      setLastSeq: vi.fn(),
      setSyncSessionId: vi.fn(),
    },
  };
});
vi.mock('./useMessages', () => ({ useMessages: () => ({
  messages: h.messages,
  messagesRef: { current: h.messages },
  addMessage: h.addMessage,
  setMessages: vi.fn(), resetMessages: vi.fn(), updateMessageAt: vi.fn(), triggerScroll: vi.fn(),
  shouldScrollRef: { current: false }, isNearBottomRef: { current: true },
}) }));
vi.mock('./useSession', () => ({ useSession: () => h.session }));
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
});
afterEach(cleanup);

describe('useChatAppState 同帧切换时的会话归属', () => {
  it('把延迟 legacy ask/permission 只记入 attached 的 A，不污染刚选中的 B 视图', () => {
    render(<Harness />);
    act(() => emit({ type: 'stream_started', sessionId: 'session-a', streamId: 'stream-a', runId: 'run-a' }));
    vi.clearAllMocks();

    act(() => {
      h.latest!.selectSession('session-b');
      emit({ type: 'ask_user', interactionId: 'ask-a', questions: [] });
      emit({ type: 'permission_request', interactionId: 'permission-a', toolName: 'Shell', toolInput: {} });
    });

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

    expect(h.latest!.loading).toBe(true);
    expect(h.addMessage).not.toHaveBeenCalled();
    expect(h.session.refreshCurrentSession).not.toHaveBeenCalled();
    expect(h.dispatchConnection).not.toHaveBeenCalledWith('complete');
  });
});
