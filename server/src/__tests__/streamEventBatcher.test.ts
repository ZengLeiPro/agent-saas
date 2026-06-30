import { afterEach, describe, expect, it, vi } from 'vitest';

import { StreamEventBatcher } from '../runtime/rawAgentLoop.js';
import type { EventStore, PlatformEvent, PlatformEventInput } from '../runtime/types.js';

class FakeEventStore implements EventStore {
  readonly batches: PlatformEventInput[][] = [];
  async append(event: PlatformEventInput): Promise<PlatformEvent> {
    this.batches.push([event]);
    return { id: `event-${this.batches.length}`, timestamp: new Date(0).toISOString(), ...event } as PlatformEvent;
  }
  async appendBatch(events: PlatformEventInput[]): Promise<PlatformEvent[]> {
    this.batches.push([...events]);
    return events.map((event, index) => ({ id: `event-${this.batches.length}-${index}`, timestamp: new Date(0).toISOString(), ...event }) as PlatformEvent);
  }
  async list(): Promise<PlatformEvent[]> { return []; }
}


class AppendOnlyEventStore implements EventStore {
  readonly appended: PlatformEventInput[] = [];
  async append(event: PlatformEventInput): Promise<PlatformEvent> {
    this.appended.push(event);
    return { id: `event-${this.appended.length}`, timestamp: new Date(0).toISOString(), ...event } as PlatformEvent;
  }
  async list(): Promise<PlatformEvent[]> { return []; }
}

function delta(content: string): PlatformEventInput {
  return {
    type: 'tool_output_delta',
    runId: 'run-1',
    sessionId: 'session-1',
    invocationId: 'inv-1',
    toolCallId: 'tool-1',
    channel: 'stdout',
    content,
  };
}

describe('StreamEventBatcher', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it('coalesces high-frequency stream deltas into appendBatch calls', async () => {
    const store = new FakeEventStore();
    const batcher = new StreamEventBatcher(store, { maxEvents: 3, maxBytes: 1000, flushIntervalMs: 0 });

    await batcher.push(delta('a'));
    await batcher.push(delta('b'));
    expect(store.batches).toHaveLength(0);
    await batcher.push(delta('c'));
    expect(store.batches.map((batch) => batch.length)).toEqual([3]);

    await batcher.push(delta('d'));
    await batcher.flush();
    expect(store.batches.map((batch) => batch.length)).toEqual([3, 1]);
  });

  it('flushes by buffered content size before maxEvents', async () => {
    const store = new FakeEventStore();
    const batcher = new StreamEventBatcher(store, { maxEvents: 10, maxBytes: 4, flushIntervalMs: 0 });

    await batcher.push(delta('ab'));
    await batcher.push(delta('cd'));

    expect(store.batches.map((batch) => batch.length)).toEqual([2]);
  });

  it('flushes slow streams on the timer interval', async () => {
    vi.useFakeTimers();
    const store = new FakeEventStore();
    const batcher = new StreamEventBatcher(store, { maxEvents: 10, maxBytes: 1000, flushIntervalMs: 50 });

    await batcher.push(delta('slow'));
    expect(store.batches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(50);

    expect(store.batches.map((batch) => batch.length)).toEqual([1]);
  });

  it('falls back to append when appendBatch is unavailable', async () => {
    const store = new AppendOnlyEventStore();
    const batcher = new StreamEventBatcher(store, { maxEvents: 2, maxBytes: 1000, flushIntervalMs: 0 });

    await batcher.push(delta('a'));
    await batcher.push(delta('b'));

    expect(store.appended.map((event) => 'content' in event ? event.content : '')).toEqual(['a', 'b']);
  });

});
