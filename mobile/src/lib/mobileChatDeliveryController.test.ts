import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatClientState, reduceChatClientState, type MessageItem, type AcceptedMessageStatus } from '@agent/shared';
import { buildMobileChatSubmission } from './chatSubmissionAdapter';
import { MobileChatDeliveryController } from './mobileChatDeliveryController';
import { mobileAcceptanceEvidence } from './mobileChatDeliveryEvidence';
import { ownsDeliveryView, type MobileAcceptanceEvidence, type MobileDeliveryFence, type MobileDeliveryView } from './mobileChatDeliveryState';
import { deliveryReferences, parseDeliveryReferences } from './mobileChatDeliveryJournal';

const fence: MobileDeliveryFence = { origin: 'https://agent.test', identity: { userId: 'u-1', tenantId: 't-1', generation: 7 } };
const draft: MobileDeliveryView = { draftId: 'draft-a', sessionId: null };
function submission(clientMsgId: string, text = 'original text') {
  const value = buildMobileChatSubmission({ clientMsgId, text, deliveryMode: 'queue', model: 'original-model', attachments: [],
    target: { agentTarget: { kind: 'personal', tenantId: 't-1' } } });
  if (!value.ok) throw new Error(value.issue.message);
  return value.value;
}
function status(id = 'c-1', state = 'queued') {
  return { clientMessageId: id, runId: `run-${id}`, sessionId: 's-1', status: state, deliveryMode: 'queue', queuePosition: 1 };
}
const response = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code });
const bubble = (id: string): Extract<MessageItem, { type: 'user' }> => ({ id: `bubble-${id}`, type: 'user', content: 'original text', clientMsgId: id, status: 'pending', timestamp: Date.now() });
const controllers: MobileChatDeliveryController[] = [];
function rig() {
  let currentFence: MobileDeliveryFence | null = fence;
  let readable = true;
  let queue = createChatClientState();
  const changed = vi.fn(); const accepted = vi.fn(); const trace = vi.fn();
  const request = vi.fn(async (_url: string, _init?: RequestInit) => response({}, 404));
  const controller = new MobileChatDeliveryController({
    fence, currentFence: () => currentFence, canRead: () => readable, request,
    onChange: changed, onAccepted: accepted, trace,
    mergeStatus: (value: AcceptedMessageStatus): MobileAcceptanceEvidence => {
      const item = { clientMsgId: value.clientMessageId, sessionId: value.sessionId, runId: value.runId,
        status: value.status, deliveryMode: value.deliveryMode, queuePosition: value.queuePosition };
      queue = reduceChatClientState(queue, { type: 'queue', sessionId: value.sessionId, event: { type: 'server_upsert', item }, generation: queue.generation });
      return { clientMsgId: value.clientMessageId, sessionId: value.sessionId, runId: value.runId,
        status: queue.queues[value.sessionId].items[value.clientMessageId].status, source: 'status' };
    },
  });
  controllers.push(controller);
  const register = (id = 'c-1') => {
    const record = controller.register(submission(id), { draftId: draft.draftId });
    if (!record) throw new Error('registration failed');
    controller.rememberBubble(record, bubble(id));
    return record;
  };
  const accept = (id = 'c-1', state: MobileAcceptanceEvidence['status'] = 'queued') => controller.accept({ clientMsgId: id, sessionId: 's-1', runId: `run-${id}`, status: state, source: 'queue' });
  return { controller, register, accept, request, changed, accepted, trace,
    identity: (value: MobileDeliveryFence | null) => { currentFence = value; },
    readable: (value: boolean) => { readable = value; },
    messages: (view = draft) => controller.project([], view),
  };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-12T00:00:00Z')); });
afterEach(() => { controllers.splice(0).forEach(controller => controller.dispose()); vi.clearAllTimers(); vi.useRealTimers(); });

describe('delivery observations are not run execution state', () => {
  it('T02: exact ACK commits acceptance before clearing the original attempt', async () => {
    const r = rig(); const record = r.register(); const attempt = record.attempt;
    expect(r.accept()).toBe(true);
    expect(record.fact).toMatchObject({ kind: 'accepted', runId: 'run-c-1', sessionId: 's-1' });
    expect(record.canonical).toBeUndefined();
    expect(attempt.controller.signal.aborted).toBe(true);
    expect(r.messages()[0]).toMatchObject({ status: 'queued', clientMsgId: 'c-1' });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(r.request).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('T03/T05: ACK-before-arm and late native failure cannot downgrade accepted', async () => {
    const r = rig(); const record = r.register(); const attempt = record.attempt;
    r.accept();
    r.controller.transportFinished(record, attempt, true);
    r.controller.transportFinished(record, attempt, false);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(record.fact.kind).toBe('accepted'); expect(r.messages()[0]).toMatchObject({ status: 'queued' });
    expect(r.request).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('T04: a late acceptance replaces unknown without changing the business ID/content', async () => {
    const r = rig(); const record = r.register();
    r.controller.transportFinished(record, record.attempt, true);
    await vi.advanceTimersByTimeAsync(16_001);
    expect(r.messages()[0]).toMatchObject({ status: 'failed', deliveryIssue: 'unknown', clientMsgId: 'c-1' });
    r.accept('c-1', 'running');
    expect(r.messages()[0]).toMatchObject({ status: 'sent', content: 'original text', clientMsgId: 'c-1', failedReason: undefined, deliveryIssue: undefined });
  });
  it('T06: an older attempt cannot arm a new timer or settle its replacement', async () => {
    const r = rig(); const record = r.register(); const old = record.attempt;
    await vi.advanceTimersByTimeAsync(1_000);
    const current = r.controller.beginAttempt(record)!;
    expect(old.controller.signal.aborted).toBe(true); expect(current.id).not.toBe(old.id);
    r.controller.transportFinished(record, old, false);
    r.controller.transportFinished(record, old, true);
    expect(record.attempt).toBe(current); expect(current.phase.kind).toBe('connecting');
    expect(r.request).not.toHaveBeenCalled(); expect(r.messages()).toHaveLength(1);
  });
  it('T08: sparse duplicate ACKs settle a receipt without inventing a Run', () => {
    const r = rig(); const record = r.register();
    const evidence: MobileAcceptanceEvidence = { clientMsgId: 'c-1', status: 'accepted', source: 'chat_ack' };
    r.controller.accept(evidence); r.controller.accept(evidence);
    expect(record.fact).toEqual({ kind: 'accepted', sessionId: undefined, runId: undefined, presentation: 'receipt' });
    expect(r.accepted).toHaveBeenCalledTimes(1); expect(r.messages()[0]).toMatchObject({ status: 'sent' });
  });
  it.each(['failed', 'cancelled', 'completed'] as const)('T25: execution %s remains delivery accepted', state => {
    const r = rig(); const record = r.register(); r.accept('c-1', state);
    r.controller.reject('c-1', 'model_not_allowed');
    expect(record.fact.kind).toBe('accepted'); expect(r.messages()[0]).toMatchObject({ status: 'sent' });
    expect(r.controller.beginAttempt(record)).toBeUndefined();
  });
  it('T19: late queued evidence cannot undo already observed Run progress', () => {
    const r = rig(); r.register(); r.accept('c-1', 'running'); r.accept('c-1', 'queued');
    expect(r.messages()[0]).toMatchObject({ status: 'sent' });
    r.accept('c-1', 'completed'); r.accept('c-1', 'queued');
    expect(r.messages()[0]).toMatchObject({ status: 'sent' });
  });
  it('T69: telemetry and presentation exceptions cannot erase accepted facts', () => {
    const r = rig(); r.trace.mockImplementation(() => { throw new Error('telemetry unavailable'); });
    const record = r.register();
    r.accepted.mockImplementation(() => { throw new Error('render unavailable'); });
    r.changed.mockImplementation(() => { throw new Error('render unavailable'); });
    expect(() => r.accept()).not.toThrow(); expect(record.fact.kind).toBe('accepted');
    expect(r.messages()[0]).toMatchObject({ status: 'queued' });
    expect(record.canonical).toBeUndefined();
  });
});

describe('read-only recovery, phase budgets and cancellation', () => {
  it('T33: ACK deadline starts at actual transport write, then verifies instead of rejecting', async () => {
    const r = rig(); const record = r.register();
    await vi.advanceTimersByTimeAsync(20_000); expect(r.request).not.toHaveBeenCalled();
    r.controller.transportFinished(record, record.attempt, true);
    await vi.advanceTimersByTimeAsync(14_999); expect(r.request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(record.attempt.phase.kind).toBe('verifying'); expect(r.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(record.fact.kind).toBe('unconfirmed'); expect(record.attempt.phase.kind).toBe('settled');
    expect(r.messages()[0]).toMatchObject({ status: 'failed', deliveryIssue: 'unknown' });
  });
  it('T28/T34: an indefinitely hanging authenticated GET reaches unknown inside its total budget', async () => {
    const r = rig(); const record = r.register();
    r.request.mockImplementation(() => new Promise(() => {}));
    const result = r.controller.verify('c-1', 'manual');
    await vi.advanceTimersByTimeAsync(12_001);
    expect((await result).kind).toBe('unknown'); expect(record.attempt.phase.kind).toBe('settled');
    expect(r.messages()[0]).toMatchObject({ status: 'failed', deliveryIssue: 'unknown' });
    expect(r.request).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
  it('T29/T30: concurrent entrypoints share the probe and a later ACK wins over 404', async () => {
    const r = rig(); r.register(); let resolveRead!: (value: Response) => void;
    r.request.mockImplementation(() => new Promise(resolve => { resolveRead = resolve; }));
    const first = r.controller.verify('c-1', 'manual');
    expect(r.controller.verify('c-1', 'recover')).toBe(first);
    r.controller.recover(); await vi.advanceTimersByTimeAsync(0);
    expect(r.request).toHaveBeenCalledTimes(1); r.accept();
    resolveRead(response({}, 404)); await vi.advanceTimersByTimeAsync(0);
    expect(await first).toEqual({ kind: 'already_accepted' });
    expect(r.messages()[0]).toMatchObject({ status: 'queued' });
    await vi.advanceTimersByTimeAsync(30_000); expect(r.request).toHaveBeenCalledTimes(1);
  });
  it('T38: foreground recovery settles an expired absolute deadline instead of restarting it', async () => {
    const r = rig(); const record = r.register(); const controller = record.attempt.controller;
    const deadline = record.attempt.phase.kind === 'connecting' ? record.attempt.phase.deadlineAt : 0;
    vi.setSystemTime(deadline + 1); r.controller.recover();
    expect(controller.signal.aborted).toBe(true); expect(record.attempt.phase.kind).toBe('verifying');
    await vi.advanceTimersByTimeAsync(1_001);
    expect(record.attempt.phase.kind).toBe('settled'); expect(record.fact.kind).toBe('unconfirmed');
  });
  it('T59: local lock suspends an unwritten attempt without revoking accepted work', async () => {
    const r = rig(); const first = r.register(); const second = r.register('c-2'); r.accept('c-2', 'running');
    r.readable(false); r.controller.suspend();
    expect(first.attempt.controller.signal.aborted).toBe(true);
    expect(r.messages().find(message => message.id === 'bubble-c-1')).toMatchObject({ status: 'failed' });
    expect(second.fact.kind).toBe('accepted'); expect(r.request).not.toHaveBeenCalled();
  });
  it('T39/T41: disposal or a new identity ignores late network continuations', async () => {
    const r = rig(); r.register(); let resolveRead!: (value: Response) => void;
    r.request.mockImplementation(() => new Promise(resolve => { resolveRead = resolve; }));
    const pending = r.controller.verify('c-1', 'manual'); await vi.advanceTimersByTimeAsync(0);
    r.identity({ ...fence, identity: { ...fence.identity, generation: 8 } });
    const calls = r.changed.mock.calls.length;
    resolveRead(response(status())); await vi.advanceTimersByTimeAsync(0); await pending;
    expect(r.changed).toHaveBeenCalledTimes(calls); expect(r.accepted).not.toHaveBeenCalled();
    expect(r.controller.accept({ clientMsgId: 'c-1', status: 'accepted', source: 'chat_ack' })).toBe(false);
    r.controller.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
});

describe('identity, view, transcript and multiple submissions', () => {
  it('T24: a known session cannot be rebound to a different response session', () => {
    const r = rig(); const record = r.controller.register(submission('c-1'), { draftId: 'draft-a', sessionId: 's-a' })!;
    expect(r.accept()).toBe(false); expect(record.fact.kind).toBe('unconfirmed');
    expect(record.owner.sessionId).toBe('s-a');
  });
  it('T42/T43/T45: two null-session drafts never share bubbles or receipt ownership', () => {
    const r = rig(); const record = r.register();
    expect(ownsDeliveryView(record, { draftId: 'draft-b', sessionId: null })).toBe(false);
    r.accept(); expect(r.messages({ draftId: 'draft-b', sessionId: null })).toEqual([]);
    expect(r.messages({ draftId: 'later-view', sessionId: 's-1' })).toHaveLength(1);
    expect(r.messages({ draftId: 'later-view', sessionId: 's-other' })).toEqual([]);
  });
  it('T13/T14: history merge projects acceptance last and deduplicates only the exact ID', () => {
    const r = rig(); r.register(); r.accept();
    const transcript: MessageItem = { ...bubble('c-1'), id: 'server-projection', status: 'sent' };
    r.controller.observeHistory([transcript], 's-1');
    const messages = r.controller.project([transcript, bubble('c-1'), bubble('different-id')], { draftId: 'draft-a', sessionId: 's-1' });
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ clientMsgId: 'c-1', status: 'queued' });
    expect(messages[1]).toMatchObject({ clientMsgId: 'different-id', deliveryIssue: 'missing_payload' });
    expect(r.controller.get('c-1')?.bubble).toBeUndefined();
  });
  it('T15: an empty snapshot and a local cancel intent provide no acceptance', () => {
    const r = rig(); const record = r.register();
    const snapshot = { version: 1 as const, sessionId: 's-1', generatedAt: new Date().toISOString(), items: [] };
    expect(mobileAcceptanceEvidence({ type: 'queue_snapshot', snapshot }, createChatClientState())).toEqual([]);
    expect(r.controller.accept({ clientMsgId: 'c-1', sessionId: 's-1', runId: 'run-c-1', status: 'cancel_pending', source: 'queue' })).toBe(false);
    expect(record.fact.kind).toBe('unconfirmed'); expect(record.attempt.phase.kind).toBe('connecting');
  });
  it('T48/T49/T51: one terminal/rejected submission cannot clear another in-flight attempt', () => {
    const r = rig(); const first = r.register(); const second = r.register('c-2');
    r.accept('c-1', 'completed');
    expect(second.attempt.phase.kind).toBe('connecting'); expect(second.attempt.controller.signal.aborted).toBe(false);
    r.controller.reject('c-2', 'model_not_allowed');
    expect(first.fact.kind).toBe('accepted'); expect(r.messages()[0]).toMatchObject({ status: 'sent' });
    expect(r.messages()[1]).toMatchObject({ status: 'failed', deliveryIssue: 'rejected' });
  });
  it('T20: cached pending without an ID exits the spinner without inventing an identity', () => {
    const r = rig(); const legacy = { ...bubble('legacy'), clientMsgId: undefined };
    expect(r.controller.project([legacy], draft)).toEqual([expect.objectContaining({ status: 'failed', clientMsgId: undefined, deliveryIssue: 'missing_payload' })]);
    expect(r.controller.records()).toEqual([]); expect(r.request).not.toHaveBeenCalled();
  });
  it('T20/T67: a restored reference has no fabricated canonical payload or attachments', async () => {
    const r = rig(); r.controller.restoreReference({ clientMsgId: 'c-1', owner: { draftId: 'draft-a' }, createdAt: Date.now() });
    const record = r.controller.get('c-1')!;
    expect(record.canonical).toBeUndefined(); expect(record.bubble).toBeUndefined();
    expect(r.controller.beginAttempt(record)).toBeUndefined();
    r.request.mockResolvedValue(response(status('c-1', 'completed')));
    r.controller.recover(); await vi.advanceTimersByTimeAsync(0);
    expect(record.fact.kind).toBe('accepted'); expect(r.messages()).toEqual([]);
  });
  it('T52/T69: original payload is immutable and the recovery journal contains IDs only', () => {
    const r = rig(); const original = submission('c-1', 'private original text');
    const record = r.controller.register(original, { draftId: 'draft-a' })!;
    original.text = 'changed composer';
    expect(record.canonical?.text).toBe('private original text'); expect(Object.isFrozen(record.canonical)).toBe(true);
    const references = deliveryReferences(r.controller.records());
    expect(JSON.stringify(references)).not.toContain('private original text');
    expect(JSON.stringify(references)).not.toContain('original-model');
    expect(parseDeliveryReferences(references)).toEqual(references);
    expect(parseDeliveryReferences([{ ...references[0], createdAt: Date.now() + 1 }])).toEqual([]);
  });
});
