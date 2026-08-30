import { describe, expect, it } from 'vitest';
import {
  createActivityMessageProjectionState,
  reduceActivityMessageProjection,
  selectProjectedMessages,
  type ActivityMessageProjectionEvent,
} from './activityMessageProjection';
import { mapSessionDetailToMessages } from './sessionsApi';
import { runtimeProjectionFixture } from './__fixtures__/activityMessageProjection.fixture';

const reduce = (events: ActivityMessageProjectionEvent[]) => events.reduce(reduceActivityMessageProjection, createActivityMessageProjectionState());
const base = { runId: 'run-1', messageId: 'assistant-run-1', blockId: 'block-1' };

describe('canonical activity/message projection', () => {
  it('deduplicates repeated deltas and only appends to the matching stable block', () => {
    const start: ActivityMessageProjectionEvent = { eventId: 'e-start', domain: 'message', kind: 'assistant_block_start', ...base, blockType: 'text' };
    const delta: ActivityMessageProjectionEvent = { eventId: 'e-delta', domain: 'message', kind: 'assistant_block_delta', ...base, blockType: 'text', delta: 'hello' };
    const stray: ActivityMessageProjectionEvent = { eventId: 'e-stray', domain: 'message', kind: 'assistant_block_delta', ...base, blockId: 'missing', blockType: 'text', delta: 'NO' };
    const state = reduce([start, delta, delta, stray]);
    expect(selectProjectedMessages(state)).toMatchObject([{ id: 'block-1', content: 'hello', streaming: true }]);
  });

  it('orders sequenced deltas deterministically despite replay and out-of-order delivery', () => {
    const start: ActivityMessageProjectionEvent = { eventId: 'ordered-start', domain: 'message', kind: 'assistant_block_start', ...base, blockType: 'text' };
    const second: ActivityMessageProjectionEvent = { eventId: 'ordered-2', domain: 'message', kind: 'assistant_block_delta', ...base, blockType: 'text', delta: 'B', sequence: 2 };
    const first: ActivityMessageProjectionEvent = { eventId: 'ordered-1', domain: 'message', kind: 'assistant_block_delta', ...base, blockType: 'text', delta: 'A', sequence: 1 };
    const state = reduce([start, second, second, first]);
    expect(selectProjectedMessages(state)).toMatchObject([{ id: 'block-1', content: 'AB', streaming: true }]);
  });

  it('merges out-of-order tool/subagent terminal facts and never revives them with old running events', () => {
    const events: ActivityMessageProjectionEvent[] = [
      { eventId: 'tool-end', domain: 'tool', kind: 'tool_activity', ...base, blockId: 'tool-block', toolCallId: 'same', toolName: 'Shell', status: 'failed', result: 'permission denied', resultReady: true },
      { eventId: 'sub-end', domain: 'subagent', kind: 'subagent_activity', ...base, blockId: 'sub-block', toolCallId: 'agent-call', subagentId: 'sub-1', agentType: 'general', status: 'failed', errorMessage: 'workflow failed' },
      { eventId: 'tool-old', domain: 'tool', kind: 'tool_activity', ...base, blockId: 'tool-block', toolCallId: 'same', toolName: 'Shell', status: 'running' },
      { eventId: 'sub-old', domain: 'subagent', kind: 'subagent_activity', ...base, blockId: 'sub-block', toolCallId: 'agent-call', subagentId: 'sub-1', agentType: 'general', status: 'running' },
    ];
    const messages = selectProjectedMessages(reduce(events));
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_use', executionStatus: 'failed', result: 'permission denied' }),
      expect.objectContaining({ type: 'subagent', status: 'failed', errorMessage: 'workflow failed' }),
    ]));
  });

  it('keeps same toolCallId isolated by runId', () => {
    const events: ActivityMessageProjectionEvent[] = [
      { eventId: 'a', domain: 'tool', kind: 'tool_activity', ...base, blockId: 'a-block', toolCallId: 'same', toolName: 'Read', status: 'completed' },
      { eventId: 'b', domain: 'tool', kind: 'tool_activity', runId: 'run-2', messageId: 'assistant-run-2', blockId: 'b-block', toolCallId: 'same', toolName: 'Write', status: 'running' },
    ];
    expect(selectProjectedMessages(reduce(events))).toEqual([
      expect.objectContaining({ id: 'a-block', toolName: 'Read', executionStatus: 'completed' }),
      expect.objectContaining({ id: 'b-block', toolName: 'Write', executionStatus: 'running' }),
    ]);
  });

  it('is replay/snapshot idempotent and full snapshots only replace an explicitly scoped message', () => {
    const old: ActivityMessageProjectionEvent = { eventId: 'old', domain: 'message', kind: 'user_message', runId: 'run-old', messageId: 'other', content: 'keep' };
    const full: ActivityMessageProjectionEvent = {
      eventId: 'snap', domain: 'message', kind: 'snapshot', runId: 'run-1', snapshotId: 's1', mode: 'full', messageId: 'assistant-run-1',
      events: [{ eventId: 'snap-block', domain: 'message', kind: 'assistant_block_snapshot', ...base, blockType: 'text', content: 'hydrated', status: 'completed' }],
    };
    const once = reduce([old, full]);
    const replayed = reduceActivityMessageProjection(once, full);
    expect(replayed).toBe(once);
    expect(selectProjectedMessages(replayed)).toEqual([
      expect.objectContaining({ id: 'other', content: 'keep' }),
      expect.objectContaining({ id: 'block-1', content: 'hydrated', streaming: false }),
    ]);
    const refreshed = reduceActivityMessageProjection(replayed, {
      ...full, eventId: 'snap-2', snapshotId: 's2',
      events: [{ eventId: 'snap-block', domain: 'message', kind: 'assistant_block_snapshot', ...base, blockType: 'text', content: 'refreshed', status: 'completed' }],
    });
    expect(selectProjectedMessages(refreshed)).toEqual([
      expect.objectContaining({ id: 'other', content: 'keep' }),
      expect.objectContaining({ id: 'block-1', content: 'refreshed', streaming: false }),
    ]);
  });

  it('preserves the hydrated message anchor when a full snapshot replaces its blocks', () => {
    const events: ActivityMessageProjectionEvent[] = [
      { eventId: 'before', domain: 'message', kind: 'assistant_block_snapshot', ...base, blockType: 'text', content: 'before', status: 'running' },
      { eventId: 'after', domain: 'message', kind: 'user_message', runId: 'other-run', messageId: 'after-message', content: 'after' },
      { eventId: 'hydrate', domain: 'message', kind: 'snapshot', runId: 'run-1', snapshotId: 'hydrate-1', mode: 'full', messageId: 'assistant-run-1', events: [
        { eventId: 'hydrated-block', domain: 'message', kind: 'assistant_block_snapshot', ...base, blockType: 'text', content: 'hydrated', status: 'completed' },
      ] },
    ];
    expect(selectProjectedMessages(reduce(events)).map((item) => item.id)).toEqual(['block-1', 'after-message']);
  });

  it('moderation is triggered only by structured domain metadata and affects only its target', () => {
    const events: ActivityMessageProjectionEvent[] = [
      { eventId: 't1', domain: 'tool', kind: 'tool_activity', ...base, blockId: 'tool', toolCallId: 'call', toolName: 'Shell', status: 'failed', result: 'blocked denied policy workflow failed' },
      { eventId: 'b1', domain: 'message', kind: 'assistant_block_snapshot', ...base, blockType: 'text', content: 'the words blocked denied policy are ordinary text', status: 'completed' },
      { eventId: 'b2', domain: 'message', kind: 'assistant_block_snapshot', ...base, blockId: 'unrelated', blockType: 'text', content: 'unrelated activity', status: 'running' },
      { eventId: 'mod-event', domain: 'moderation', kind: 'moderation_outcome', runId: 'run-1', moderationId: 'mod-1', messageId: 'assistant-run-1', blockId: 'block-1', outcome: 'blocked', reasonCode: 'off_topic' },
    ];
    const messages = selectProjectedMessages(reduce(events));
    expect(messages.find((m) => m.id === 'block-1')).toMatchObject({ moderation: { outcome: 'blocked', reasonCode: 'off_topic' } });
    expect(messages.find((m) => m.id === 'unrelated')).not.toHaveProperty('moderation');
    expect(messages.find((m) => m.id === 'tool')).not.toHaveProperty('moderation');
  });

  it('stream restart uses blockId rather than array position', () => {
    const events: ActivityMessageProjectionEvent[] = [
      { eventId: 's1', domain: 'message', kind: 'assistant_block_start', ...base, blockType: 'text' },
      { eventId: 'd1', domain: 'message', kind: 'assistant_block_delta', ...base, blockType: 'text', delta: 'first' },
      { eventId: 'e1', domain: 'message', kind: 'assistant_block_end', ...base, blockType: 'text' },
      { eventId: 's2', domain: 'message', kind: 'assistant_block_start', ...base, blockId: 'block-2', blockType: 'text' },
      { eventId: 'd2', domain: 'message', kind: 'assistant_block_delta', ...base, blockId: 'block-2', blockType: 'text', delta: 'second' },
    ];
    expect(selectProjectedMessages(reduce(events))).toEqual([
      expect.objectContaining({ id: 'block-1', content: 'first', streaming: false }),
      expect.objectContaining({ id: 'block-2', content: 'second', streaming: true }),
    ]);
  });

  it('matches transcript hydrate for the same stable assistant block', () => {
    const live = selectProjectedMessages(reduce([{
      eventId: 'live-snapshot', domain: 'message', kind: 'assistant_block_snapshot',
      runId: 'run-1', messageId: 'assistant-run-1', blockId: 'stable-block',
      blockType: 'text', content: 'same content', status: 'completed', timestamp: 123,
    }]));
    const hydrated = mapSessionDetailToMessages({
      sessionId: 's1', stats: { lines: 1, parsedLines: 1, parseErrors: 0 },
      blocks: [{ id: 'stable-block', tsMs: 123, kind: 'text', title: '输出', defaultOpen: true, content: 'same content', runId: 'run-1' }],
    });
    expect(live).toMatchObject(hydrated);
  });


  it('projects the captured runtime fixture without cross-domain moderation inference', () => {
    const messages = selectProjectedMessages(reduce(runtimeProjectionFixture));
    expect(messages.find((item) => item.id === 'text-1')).toMatchObject({
      content: 'assistant says blocked denied policy', moderation: { outcome: 'blocked' },
    });
    expect(messages.find((item) => item.id === 'tool-1')).toMatchObject({
      executionStatus: 'failed', result: 'permission denied; workflow failed; blocked by remote API',
    });
    expect(messages.find((item) => item.id === 'sub-1')).toMatchObject({ status: 'failed' });
  });

});
