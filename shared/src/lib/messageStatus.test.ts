import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseMessageStatus, readMessageStatus, beforeReadDeadline, type MessageStatusFetch } from './messageStatus';
import { MessageStatusProbePool } from './messageStatusProbePool';

const accepted = { clientMessageId: 'c-1', runId: 'r-1', messageId: 'r-1', sessionId: 's-1', conversationId: 's-1', status: 'queued', deliveryMode: 'queue', queuePosition: 1 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const request = () => vi.fn<MessageStatusFetch>();
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-12T00:00:00Z')); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('message status read contract (T21–T30, T34)', () => {
  it.each(['queued', 'running', 'completed', 'cancelled', 'failed'])('accepts a correlated %s run, including terminal execution failures', async status => {
    const fetch = request().mockResolvedValue(json({ ...accepted, status }));
    const result = await readMessageStatus('c-1', { request: fetch });
    expect(result).toEqual({ kind: 'accepted', value: { clientMessageId: 'c-1', runId: 'r-1', sessionId: 's-1', status, deliveryMode: 'queue', queuePosition: 1 } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toEqual(['/api/messages/c-1/status', expect.objectContaining({ method: 'GET', cache: 'no-store', signal: expect.any(AbortSignal) })]);
  });
  it.each([
    null, [], {}, { ...accepted, runId: '' }, { ...accepted, sessionId: '' },
    { ...accepted, status: 'waiting_secret' }, { ...accepted, status: {} },
    { ...accepted, messageId: 'other' }, { ...accepted, conversationId: 'other' },
    { ...accepted, deliveryMode: 'new-route' }, { ...accepted, queuePosition: 0 },
    { ...accepted, queuePosition: -1 }, { ...accepted, queuePosition: 1.2 },
    { ...accepted, queuePosition: '1' }, { ...accepted, queuePosition: Infinity },
  ].map(body => [body]))('T22: malformed 200 never becomes acceptance (%j)', body => {
    expect(parseMessageStatus(body, 'c-1').kind).toBe('unknown');
  });
  it('T23/T24: separates wrong business ID from a bound-session mismatch', () => {
    expect(parseMessageStatus({ ...accepted, clientMessageId: 'other' }, 'c-1')).toEqual({ kind: 'unknown', reason: 'message_mismatch' });
    expect(parseMessageStatus(accepted, 'c-1', 'other-session')).toEqual({ kind: 'unknown', reason: 'session_mismatch' });
  });
  it('T21: a draft with only clientMsgId needs no create-session request', async () => {
    const fetch = request().mockResolvedValue(json({ ...accepted, clientMessageId: 'id/with?punctuation' }));
    const result = await readMessageStatus('id/with?punctuation', { request: fetch });
    expect(result.kind).toBe('accepted');
    expect(fetch.mock.calls[0][0]).toBe('/api/messages/id%2Fwith%3Fpunctuation/status');
    expect(fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });
  it('T26: two 404s are only not_observed, never a rejection or a business write', async () => {
    const fetch = request().mockImplementation(async () => json({}, 404));
    const promise = readMessageStatus('c-1', { request: fetch });
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await promise).toEqual({ kind: 'not_observed' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([401, 403] as const)('T27: stops on %s without retrying or changing authentication', async status => {
    const fetch = request().mockResolvedValue(json({}, status));
    expect(await readMessageStatus('c-1', { request: fetch })).toEqual({ kind: 'unauthorized', status });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('T28: bounded retry for an unavailable server', async () => {
    const fetch = request().mockImplementation(async () => json({}, 503));
    const result = readMessageStatus('c-1', { request: fetch });
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await result).toEqual({ kind: 'unknown', reason: 'unavailable' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('T28: credential/network promises that ignore AbortSignal cannot retain the spinner', async () => {
    const fetch = request().mockImplementation(() => new Promise(() => {}));
    const result = readMessageStatus('c-1', { request: fetch });
    await vi.advanceTimersByTimeAsync(11_001);
    expect(await result).toEqual({ kind: 'unknown', reason: 'deadline' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('T28: response body parsing shares the same deadline', async () => {
    const response = json(accepted);
    vi.spyOn(response, 'json').mockImplementation(() => new Promise(() => {}));
    const fetch = request().mockImplementation(async () => response);
    const result = readMessageStatus('c-1', { request: fetch });
    await vi.advanceTimersByTimeAsync(11_001);
    expect((await result).kind).toBe('unknown');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('T28: malformed JSON has a safe classification, not the raw response', async () => {
    const fetch = request().mockResolvedValue(new Response('private server error with token=SECRET'));
    expect(await readMessageStatus('c-1', { request: fetch })).toEqual({ kind: 'unknown', reason: 'invalid_response' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('T30: cancellation consumes a late rejected read without applying its result', async () => {
    let rejectRead!: (reason: Error) => void;
    const fetch = request().mockImplementation(() => new Promise((_resolve, reject) => { rejectRead = reject; }));
    const controller = new AbortController();
    const result = readMessageStatus('c-1', { request: fetch, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await result).toEqual({ kind: 'unknown', reason: 'cancelled' });
    rejectRead(new Error('late private network diagnostic'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not start a read when already cancelled or already expired', async () => {
    const read = vi.fn(async () => true);
    const controller = new AbortController(); controller.abort();
    await expect(beforeReadDeadline(read, Date.now() + 1_000, controller.signal)).rejects.toThrow('cancelled');
    await expect(beforeReadDeadline(read, Date.now())).rejects.toThrow('deadline');
    expect(read).not.toHaveBeenCalled();
  });
});

describe('identity-owned read limiter (T29/T34)', () => {
  it('same ID is single-flight, not one GET per recovery callback', async () => {
    const fetch = request().mockResolvedValue(json(accepted));
    const pool = new MessageStatusProbePool(fetch);
    const first = pool.probe('c-1');
    expect(pool.probe('c-1')).toBe(first);
    expect(pool.probe('c-1')).toBe(first);
    expect((await first).kind).toBe('accepted');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(pool.activeCount).toBe(0);
    pool.dispose();
  });
  it('at most two different IDs run concurrently; queueing is inside the original 12 seconds', async () => {
    const fetch = request().mockImplementation(() => new Promise(() => {}));
    const pool = new MessageStatusProbePool(fetch);
    const all = Promise.all(['c-1', 'c-2', 'c-3', 'c-4'].map(id => pool.probe(id)));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(pool.activeCount).toBe(2); expect(pool.waitingCount).toBe(2);
    await vi.advanceTimersByTimeAsync(12_001);
    expect((await all).every(result => result.kind === 'unknown')).toBe(true);
    expect(pool.activeCount).toBe(0); expect(pool.waitingCount).toBe(0);
    expect(fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
    pool.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
  it('cancelling one probe leaves other IDs alive', async () => {
    const fetch = request().mockImplementation(async url => url.includes('c-2')
      ? json({ ...accepted, clientMessageId: 'c-2' }) : new Promise(() => {}));
    const pool = new MessageStatusProbePool(fetch);
    const first = pool.probe('c-1'); const second = pool.probe('c-2');
    await vi.advanceTimersByTimeAsync(0); pool.cancel('c-1');
    expect((await first).kind).toBe('unknown'); expect((await second).kind).toBe('accepted');
    pool.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
});
