// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoundaryIdentity, CanonicalWsChatMessage, WsEvent } from '@agent/shared';
import type { ChatAppState } from './useChatAppState';

// Only native devices, credentials and network I/O are replaced. The production message buffer,
// useSession, queue reducer, receipt code and watchdog all execute through the real root Hook.
const io = vi.hoisted(() => ({
  identity: { userId: 'u-1', tenantId: 't-1', generation: 1 } as BoundaryIdentity | null,
  user: { id: 'u-1', username: 'leo', tenantId: 't-1', role: 'user' },
  locked: false,
  offlineShell: false,
  handlers: new Set<(envelope: { data: WsEvent }) => void>(),
  states: new Set<(state: string) => void>(),
  appStates: new Set<(state: string) => void>(),
  storage: new Map<string, string>(),
  request: vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(),
  write: vi.fn<(message: unknown, options?: unknown) => Promise<boolean>>(),
  send: vi.fn(() => true),
  latest: null as ChatAppState | null,
}));
vi.mock('@agent/shared', async (importOriginal) => {
  const real = await importOriginal<typeof import('@agent/shared')>();
  return {
    ...real,
    authFetch: io.request,
    fetchAgentProfile: async () => null,
    getPlatform: () => ({
      storage: { getItem: async (key: string) => io.storage.get(key) ?? null,
        setItem: async (key: string, value: string) => { io.storage.set(key, value); },
        removeItem: async (key: string) => { io.storage.delete(key); } },
      messageCache: { save: vi.fn(), load: async () => null, clear: vi.fn() },
      platformConfig: { getBaseUrl: () => 'https://agent.test', getWsUrl: () => 'wss://agent.test/ws' },
    }),
    wsClient: {
      currentState: 'connected', isConnected: true, isSendingFrozen: false,
      acquire: async () => () => {},
      onMessage: (fn: (envelope: { data: WsEvent }) => void) => { io.handlers.add(fn); return () => io.handlers.delete(fn); },
      onStateChange: (fn: (state: string) => void) => { io.states.add(fn); return () => io.states.delete(fn); },
      ensureConnectedSend: io.write, send: io.send,
      setLastSeq: vi.fn(), setSyncSessionId: vi.fn(),
    },
  };
});
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: io.identity ? io.user : null, identity: io.identity }) }));
vi.mock('../contexts/LocalAppLockContext', () => ({ useLocalAppLock: () => ({ locked: io.locked, offlineShell: io.offlineShell }) }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async (key: string) => io.storage.get(key) ?? null,
  setItem: async (key: string, value: string) => { io.storage.set(key, value); },
  removeItem: async (key: string) => { io.storage.delete(key); },
  getAllKeys: async () => [...io.storage.keys()],
  multiGet: async (keys: string[]) => keys.map(key => [key, io.storage.get(key) ?? null]),
  multiRemove: async (keys: string[]) => { keys.forEach(key => io.storage.delete(key)); },
} }));
vi.mock('react-native', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-native')>(),
  AppState: { currentState: 'active', addEventListener: (_: string, fn: (state: string) => void) => {
    io.appStates.add(fn); return { remove: () => io.appStates.delete(fn) };
  } },
}));
vi.mock('expo-audio', () => ({ AudioModule: { requestRecordingPermissionsAsync: vi.fn() } }));
vi.mock('expo-file-system', () => ({ File: class { delete() {} }, Paths: { cache: 'cache' } }));
vi.mock('expo-document-picker', () => ({ getDocumentAsync: async () => ({ canceled: true }) }));
vi.mock('expo-image-picker', () => ({ launchCameraAsync: vi.fn(), launchImageLibraryAsync: vi.fn() }));
vi.mock('expo-image-manipulator', () => ({ manipulateAsync: vi.fn(), SaveFormat: { JPEG: 'jpeg' } }));
vi.mock('../telemetry/runtime', () => ({ telemetryClient: () => null }));

import { useChatAppStateCore } from './useChatAppState';
function Harness() { io.latest = useChatAppStateCore(); return null; }
const state = () => io.latest!;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const target = { kind: 'personal' as const, tenantId: 't-1' };
const requests: string[] = [];
async function tick(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function mount() { const view = render(<Harness />); await tick(); return view; }
async function emit(data: WsEvent) { await act(async () => { for (const handler of [...io.handlers]) handler({ data }); }); await tick(); }
async function submit(text = 'delivery regression') {
  act(() => state().setInput(text));
  await act(async () => state().sendMessage());
  await tick();
  const chats = io.write.mock.calls.map(([message]) => message as CanonicalWsChatMessage).filter(message => message.action === 'chat');
  expect(chats).toHaveLength(1);
  expect(state().messages).toContainEqual(expect.objectContaining({ type: 'user', status: 'pending', clientMsgId: chats[0]!.submission.clientMsgId }));
  return chats[0]!.submission.clientMsgId;
}
function queueItem(clientMsgId: string) {
  return { sessionId: 's-1', clientMsgId, runId: 'r-1', sourceRunId: 'r-1', deliveryMode: 'queue' as const,
    status: 'queued' as const, queuePosition: 1, content: 'delivery regression' };
}
const bubble = (id: string) => state().messages.find(message => (message.type === 'user' || message.type === 'user-voice') && message.clientMsgId === id);

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  io.identity = { userId: 'u-1', tenantId: 't-1', generation: 1 }; io.locked = false; io.offlineShell = false;
  io.handlers.clear(); io.states.clear(); io.appStates.clear(); io.storage.clear(); requests.length = 0; io.latest = null;
  io.write.mockResolvedValue(true);
  io.request.mockImplementation(async (url) => {
    requests.push(url);
    if (url === '/api/org-agents/mine') return json({ version: 1, tenantId: 't-1', personal: { target, availability: { status: 'available' } }, orgAgents: [], selectableTargets: [target] });
    if (url === '/api/models') return json({ default: 'model-a', models: [] });
    if (url.includes('pending-interactions')) return json({ interactions: [] });
    if (url.includes('/stream-status')) return json({ active: false });
    if (url.startsWith('/api/sessions?')) return json({ sessions: [], hasMore: false });
    return json({}, 404);
  });
});
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); });

describe('iOS delivery: actual Hook acceptance recovery', () => {
  it('T09: sync_ok message_queued settles the exact bubble and preserves draft binding', async () => {
    await mount(); const id = await submit();
    await emit({ type: 'sync_ok', seq: 1, events: [{ seq: 1, event: { type: 'message_queued', sessionId: 's-1', clientMsgId: id, runId: 'r-1', deliveryMode: 'queue', content: 'delivery regression', timestamp: Date.now(), queuePosition: 1 } }] } as WsEvent);
    expect(bubble(id)).toMatchObject({ status: 'queued', clientMsgId: id });
    expect(state().sessionId).toBe('s-1');
    await tick(15_001);
    expect(bubble(id)).toMatchObject({ status: 'queued' });
    expect(io.write.mock.calls.filter(([m]) => (m as { action: string }).action === 'chat')).toHaveLength(1);
  });
  it('T10: queue_item_updated settles delivery even when the connection-scoped ACK cannot replay', async () => {
    await mount(); const id = await submit();
    await emit({ type: 'queue_item_updated', item: queueItem(id) });
    expect(bubble(id)).toMatchObject({ status: 'queued' });
    expect(state().sessionId).toBe('s-1');
    await tick(15_001); expect(bubble(id)).toMatchObject({ status: 'queued' });
  });
  it('T11: WS queue_snapshot is acceptance evidence for its matching item', async () => {
    await mount(); const id = await submit();
    await emit({ type: 'queue_snapshot', snapshot: { version: 1, sessionId: 's-1', generatedAt: new Date().toISOString(), items: [queueItem(id)] } } as WsEvent);
    expect(bubble(id)).toMatchObject({ status: 'queued' });
    expect(state().sessionId).toBe('s-1');
    await tick(15_001); expect(bubble(id)).toMatchObject({ status: 'queued' });
  });
  it('T12: a complete inline sync_overflow snapshot does not need a second history request', async () => {
    await mount(); const id = await submit();
    await emit({ type: 'sync_overflow', seq: 2, recovery: { version: 1, authoritative: true, refresh: { sessions: { method: 'GET', path: '/api/sessions' }, sessionDetail: { method: 'GET', pathTemplate: '/api/sessions/:sessionId', includes: ['queueSnapshot', 'lastRunState'] }, runtime: { method: 'GET', pathTemplate: '/api/sessions/:sessionId/stream-status' }, pendingInteractions: { transport: 'ws', action: 'resume', responseType: 'pending_interactions' } }, session: { sessionId: 's-1', queueSnapshot: { version: 1, sessionId: 's-1', generatedAt: new Date().toISOString(), items: [queueItem(id)] }, runtime: { runId: 'r-1', active: true }, pendingInteractions: [] } } } as WsEvent);
    expect(bubble(id)).toMatchObject({ status: 'queued' });
    expect(state().sessionId).toBe('s-1');
    await tick(15_001); expect(bubble(id)).toMatchObject({ status: 'queued' });
  });
  it('T01: the first real React send arms the run watchdog before any rerender', async () => {
    await mount();
    // Keep transport unresolved: the only 60-second timer in this mocked external transport is the
    // actual watchdog. No loading ref is touched by the test, and no server event is injected.
    io.write.mockImplementation(() => new Promise<boolean>(() => {}));
    act(() => state().setInput('first send without events'));
    act(() => { void state().sendMessage(); });
    await tick();
    expect(state().loading).toBe(true);
    await tick(60_001);
    expect(state().loading).toBe(false);
    expect(io.write.mock.calls.filter(([m]) => (m as { action: string }).action === 'chat')).toHaveLength(1);
  });
});
