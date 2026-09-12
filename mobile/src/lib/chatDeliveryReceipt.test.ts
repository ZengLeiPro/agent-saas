import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageItem, WsEvent } from '@agent/shared';
import { acknowledgeMobileChatBubble, armMobileChatAckDeadline, createMobileChatReceiptHandlers,
  hasMobileChatBubble, type MobileChatDelivery } from './chatDeliveryReceipt';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function harness() {
  const messagesRef = { current: [
    { id: 'bubble-1', type: 'user', content: 'hello', clientMsgId: 'intent-1', status: 'pending' },
  ] as MessageItem[] };
  const target = { messagesRef, updateMessageAt: (index: number, update: (message: MessageItem) => MessageItem) => {
    messagesRef.current[index] = update(messagesRef.current[index]);
  } };
  const entries = new Map<string, MobileChatDelivery>([['intent-1', { clientMsgId: 'intent-1', state: 'sending' }]]);
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const onExpired = vi.fn(() => {
    const message = messagesRef.current[0];
    if (message.type === 'user') messagesRef.current[0] = { ...message, status: 'failed', failedReason: 'confirmation unknown' };
  });
  const arm = () => armMobileChatAckDeadline('intent-1', {
    timers, getEntry: (id) => hasMobileChatBubble(messagesRef.current, id) ? entries.get(id) : undefined,
    timeoutMs: 15_000, onExpired,
  });
  const ack = () => {
    const entry = entries.get('intent-1');
    if (entry) entry.state = 'acked';
    acknowledgeMobileChatBubble(target, 'intent-1');
  };
  return { target, entries, timers, onExpired, arm, ack };
}

describe('mobile delivery receipts and ACK deadline ordering', () => {
  it('does not arm a timeout when ACK arrived before the transport promise resumed', () => {
    const h = harness(); h.ack(); h.arm();
    vi.advanceTimersByTime(15_001);
    expect(h.timers.size).toBe(0);
    expect(h.onExpired).not.toHaveBeenCalled();
    expect(h.target.messagesRef.current[0]).toMatchObject({ status: 'sent', clientMsgId: 'intent-1' });
  });
  it('never turns an acknowledged message into failure even if timer cancellation raced', () => {
    const h = harness(); h.arm(); h.ack();
    vi.advanceTimersByTime(15_001);
    expect(h.onExpired).not.toHaveBeenCalled();
    expect(h.target.messagesRef.current[0]).toMatchObject({ status: 'sent' });
  });
  it('reconciles a late ACK after an unknown-result timeout without changing the message identity', () => {
    const h = harness(); h.arm();
    vi.advanceTimersByTime(15_000);
    expect(h.entries.get('intent-1')?.state).toBe('verifying');
    expect(h.target.messagesRef.current[0]).toMatchObject({ status: 'failed' });
    h.ack();
    expect(h.target.messagesRef.current[0]).toEqual({ id: 'bubble-1', type: 'user', content: 'hello',
      clientMsgId: 'intent-1', status: 'sent', failedReason: undefined });
    expect(h.entries.get('intent-1')?.state).toBe('acked');
  });
  it.each(['removed', 'replaced', 'different-view'] as const)('ignores an expired attempt that was %s', (reason) => {
    const h = harness(); h.arm();
    if (reason === 'removed') h.entries.delete('intent-1');
    if (reason === 'replaced') h.entries.set('intent-1', { clientMsgId: 'intent-1', state: 'sending' });
    if (reason === 'different-view') h.target.messagesRef.current = [];
    vi.advanceTimersByTime(15_001);
    expect(h.onExpired).not.toHaveBeenCalled();
  });
  it('does not start a stale timeout after switching conversation during connection recovery', () => {
    const h = harness(); h.target.messagesRef.current = []; h.arm();
    expect(h.timers.size).toBe(0);
  });
  it('retains queued state and never marks an unrelated message sent', () => {
    const h = harness();
    h.target.messagesRef.current = [
      { id: 'queued', type: 'user', content: 'queued', clientMsgId: 'intent-1', status: 'queued' },
      { id: 'other', type: 'user', content: 'other', clientMsgId: 'intent-2', status: 'pending' },
    ];
    acknowledgeMobileChatBubble(h.target, 'unknown'); h.ack();
    expect(h.target.messagesRef.current.map((message) => 'status' in message ? message.status : null)).toEqual(['queued', 'pending']);
  });
  it('honors an accepted/queued receipt without claiming the business execution is running', () => {
    const h = harness();
    acknowledgeMobileChatBubble(h.target, 'intent-1', true);
    expect(h.target.messagesRef.current[0]).toMatchObject({ status: 'queued' });
  });
  it('settles a voice intent using the same server receipt rather than a transcript-text match', () => {
    const h = harness();
    h.target.messagesRef.current = [{ id: 'voice', type: 'user-voice', audioUrl: '/api/attachments/a/audio',
      duration: 1, clientMsgId: 'intent-1', status: 'failed', failedReason: 'unknown' }];
    h.ack();
    expect(h.target.messagesRef.current[0]).toMatchObject({ id: 'voice', status: 'sent', failedReason: undefined });
  });
  it('wires receipt correlation, controller ownership and recovery into the real mobile hook', () => {
    const source = readFileSync(new URL('../hooks/useChatAppState.ts', import.meta.url), 'utf8');
    expect(source).toContain("import { useMobileChatDelivery } from './useMobileChatDelivery';");
    expect(source).toContain('const delivery = useMobileChatDelivery({');
    expect(source).toContain('const receiptOwner = delivery;');
    expect(source).toContain('applyAuthoritativeWsEvent(data');
    expect(source).toContain('const isDeliveryReceipt =');
    expect(source).toContain('if (!isMetadata && !isDeliveryReceipt) return;');
  });
});

function receiptHarness() {
  const h = harness();
  const outbox = { current: [...h.entries.values()] };
  const selected = { current: null as string | null };
  const confirmSession = vi.fn((sessionId: string) => { selected.current = sessionId; });
  const onAllRejected = vi.fn();
  const observeAck = vi.fn();
  const receipt: WsEvent = { type: 'chat_ack', client_msg_id: 'intent-1', server_recv_ts: 1,
    sessionId: 'server-session', status: 'accepted' };
  const handlers = createMobileChatReceiptHandlers({
    target: h.target, outbox, timers: h.timers, sourceEvent: receipt,
    getSelectedSessionId: () => selected.current, confirmSession, onAllRejected, observeAck,
  });
  return { ...h, outbox, selected, confirmSession, onAllRejected, observeAck, receipt, handlers };
}

describe('mobile receipt callbacks used by the real WS processor', () => {
  it('settles an ACK, cancels its deadline, and binds only the visible new-session intent', () => {
    const h = receiptHarness(); h.arm();
    h.handlers.onChatAck('intent-1', h.receipt);
    expect(h.outbox.current[0]).toMatchObject({ state: 'acked', sessionId: 'server-session' });
    expect(h.target.messagesRef.current[0]).toMatchObject({ status: 'queued' });
    expect(h.confirmSession).toHaveBeenCalledExactlyOnceWith('server-session');
    vi.advanceTimersByTime(15_001);
    expect(h.onExpired).not.toHaveBeenCalled();
    expect(h.timers.size).toBe(0);
  });
  it.each(['different-draft', 'selected-session'] as const)('does not navigate a %s for a late ACK', (view) => {
    const h = receiptHarness();
    if (view === 'different-draft') h.target.messagesRef.current = [];
    else h.selected.current = 'other-session';
    h.handlers.onChatAck('intent-1', h.receipt);
    expect(h.confirmSession).not.toHaveBeenCalled();
  });
  it('handles stream receipts without reading ACK-only fields or inventing a new session', () => {
    const h = receiptHarness();
    h.handlers.onChatAck('intent-1', { type: 'stream_id', streamId: 'stream', client_msg_id: 'intent-1' });
    expect(h.target.messagesRef.current[0]).toMatchObject({ status: 'sent' });
    expect(h.confirmSession).not.toHaveBeenCalled();
  });
  it('does not let failed telemetry swallow an authoritative acceptance', () => {
    const h = receiptHarness();
    h.observeAck.mockImplementation(() => { throw new Error('telemetry unavailable'); });
    expect(() => h.handlers.onChatAck('intent-1', h.receipt)).not.toThrow();
    expect(h.outbox.current[0].state).toBe('acked');
    expect(h.target.messagesRef.current[0]).toMatchObject({ status: 'queued' });
  });
  it('rejects only the matching intent and does not clear another sending intent', () => {
    const h = receiptHarness(); h.arm();
    h.outbox.current.push({ clientMsgId: 'other', state: 'sending' });
    h.handlers.onChatRejected('intent-1', 'unavailable', 'Unavailable');
    expect(h.outbox.current).toEqual([{ clientMsgId: 'other', state: 'sending' }]);
    expect(h.onAllRejected).not.toHaveBeenCalled();
    expect(h.timers.size).toBe(0);
    h.handlers.onChatRejected('other', 'unavailable', 'Unavailable');
    expect(h.onAllRejected).toHaveBeenCalledOnce();
  });
  it('cleans up a terminal receipt without sending work or clearing unrelated entries', () => {
    const h = receiptHarness(); h.arm();
    h.handlers.onChatDone(undefined, undefined);
    expect(h.outbox.current).toHaveLength(1);
    h.handlers.onChatDone('intent-1', undefined);
    expect(h.outbox.current).toHaveLength(0);
    expect(h.timers.size).toBe(0);
    expect(h.onAllRejected).not.toHaveBeenCalled();
  });
});
