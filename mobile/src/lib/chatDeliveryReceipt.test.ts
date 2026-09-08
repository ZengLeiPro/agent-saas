import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageItem } from '@agent/shared';
import { acknowledgeMobileChatBubble, armMobileChatAckDeadline, hasMobileChatBubble, type MobileChatDelivery } from './chatDeliveryReceipt';

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
  it('wires receipt correlation and deadline ownership into the real mobile hook', () => {
    const source = readFileSync(new URL('../hooks/useChatAppState.ts', import.meta.url), 'utf8');
    expect(source).toContain('armMobileChatAckDeadline(clientMsgId');
    expect(source).toContain('acknowledgeMobileChatBubble(msgRef.current, clientMsgId, queued)');
    expect(source).toContain('const isDeliveryReceipt =');
    expect(source).toContain('if (!isMetadata && !isDeliveryReceipt) return;');
  });
});
