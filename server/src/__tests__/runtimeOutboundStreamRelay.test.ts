import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeOutboundStreamRelay } from '../runtime/runtimeOutboundStreamRelay.js';
import type { PlatformEventInput } from '../runtime/types.js';

describe('RuntimeOutboundStreamRelay', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces high-frequency deltas while preserving stream boundaries and draft controls', async () => {
    vi.useFakeTimers();
    const appended: PlatformEventInput[] = [];
    const relay = new RuntimeOutboundStreamRelay({
      append: vi.fn(async (event: PlatformEventInput) => {
        appended.push(event);
        return { ...event, id: `evt-${appended.length}`, timestamp: new Date().toISOString() } as any;
      }),
    } as any, { flushIntervalMs: 50, maxBatchChars: 256 });
    const context = { runId: 'run-1', sessionId: 'session-1', tenantId: 'tenant-1' };

    await relay.publish({ type: 'text_start', draftId: 'draft-1' }, context);
    await relay.publish({ type: 'text_delta', content: 'MULTIPROCESS_' }, context);
    await relay.publish({ type: 'text_delta', content: 'DONE' }, context);

    expect(appended).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(appended).toHaveLength(2);
    expect(appended[1]).toMatchObject({
      type: 'assistant_stream_event',
      blockType: 'text',
      phase: 'delta',
      content: 'MULTIPROCESS_DONE',
    });

    await relay.publish({ type: 'text_end' }, context);
    await relay.publish({ type: 'draft_commit', draftId: 'draft-1' }, context);
    await relay.publish({ type: 'done' }, context);

    expect(appended.map((event) => (event as { phase?: string }).phase)).toEqual(['start', 'delta', 'end', 'commit']);
  });

  it('flushes the pending tail before text_end even when the timer has not fired', async () => {
    vi.useFakeTimers();
    const appended: PlatformEventInput[] = [];
    const relay = new RuntimeOutboundStreamRelay({
      append: vi.fn(async (event: PlatformEventInput) => {
        appended.push(event);
        return { ...event, id: `evt-${appended.length}`, timestamp: new Date().toISOString() } as any;
      }),
    } as any, { flushIntervalMs: 1_000 });
    const context = { runId: 'run-2', sessionId: 'session-2' };

    await relay.publish({ type: 'text_start' }, context);
    await relay.publish({ type: 'text_delta', content: 'tail' }, context);
    await relay.publish({ type: 'text_end' }, context);

    expect(appended.map((event) => {
      const streamEvent = event as { phase?: string; content?: string };
      return [streamEvent.phase, streamEvent.content];
    })).toEqual([
      ['start', undefined],
      ['delta', 'tail'],
      ['end', undefined],
    ]);
  });
});
