import { afterEach, describe, expect, it, vi } from 'vitest';

import { StreamEventBatcher, ToolStreamSummaryBuilder } from '../runtime/rawAgentLoop.js';
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

describe('ToolStreamSummaryBuilder', () => {
  const summaryArgs = {
    runId: 'run-1',
    sessionId: 'session-1',
    invocationId: 'inv-1',
    toolCallId: 'tool-1',
    toolName: 'Shell',
    status: 'success' as const,
  };

  it('builds a compact summary from stream output and progress chunks', () => {
    const builder = new ToolStreamSummaryBuilder();

    builder.observe({ type: 'output', channel: 'stdout', content: 'hello' });
    builder.observe({ type: 'output', channel: 'stderr', content: '错误' });
    builder.observe({ type: 'progress', message: 'step-1' });

    expect(builder.build(summaryArgs)).toMatchObject({
      type: 'tool_stream_summary',
      runId: 'run-1',
      sessionId: 'session-1',
      invocationId: 'inv-1',
      toolCallId: 'tool-1',
      toolName: 'Shell',
      status: 'success',
      stdoutBytes: 5,
      stderrBytes: Buffer.byteLength('错误', 'utf8'),
      outputChunks: 2,
      progressCount: 1,
      truncated: false,
      stdoutTail: 'hello',
      stderrTail: '错误',
      progressTail: ['step-1'],
    });
  });

  it('keeps bounded tails for long streams', () => {
    const builder = new ToolStreamSummaryBuilder();

    builder.observe({ type: 'output', channel: 'stdout', content: `${'a'.repeat(9_000)}END` });
    for (let i = 0; i < 25; i += 1) {
      builder.observe({ type: 'progress', message: `step-${i}` });
    }

    const summary = builder.build(summaryArgs);
    if (!summary || summary.type !== 'tool_stream_summary') {
      throw new Error('expected tool_stream_summary');
    }
    expect(summary.truncated).toBe(true);
    expect(summary.stdoutTail).toHaveLength(8 * 1024);
    expect(summary.stdoutTail).toMatch(/END$/);
    expect(summary.progressTail).toHaveLength(20);
    expect(summary.progressTail?.[0]).toBe('step-5');
    expect(summary.progressTail?.[19]).toBe('step-24');
  });

  it('omits summaries when no stream chunks were observed', () => {
    const builder = new ToolStreamSummaryBuilder();

    expect(builder.build(summaryArgs)).toBeUndefined();
  });
});
