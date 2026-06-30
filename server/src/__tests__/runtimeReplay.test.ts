import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { FileApprovalStore } from '../runtime/approvalStore.js';
import { FileEventStore } from '../runtime/fileEventStore.js';
import { buildRuntimeReplayState } from '../runtime/replay.js';

describe('runtime replay state', () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    cleanupDirs.clear();
  });

  it('derives pending approvals and closed tool calls from event and approval logs', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'runtime-replay-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'));
    const approvalStore = new FileApprovalStore(join(cwd, 'session.approvals.jsonl'));

    await eventStore.append({
      type: 'run_started',
      runId: 'run-1',
      sessionId: 'session-1',
      model: 'gpt-5.5',
      channel: 'web',
    });
    await eventStore.append({
      type: 'assistant_tool_calls',
      runId: 'run-1',
      sessionId: 'session-1',
      content: '',
      toolCalls: [
        { id: 'call-write', name: 'Write', arguments: JSON.stringify({ path: 'a.txt', content: 'A' }) },
        { id: 'call-read', name: 'Read', arguments: JSON.stringify({ path: 'a.txt' }) },
      ],
    });
    const approval = await approvalStore.create({
      sessionId: 'session-1',
      runId: 'run-1',
      toolCallId: 'call-write',
      toolId: 'Write',
      toolName: 'Write',
      displayName: 'Write File',
      input: { path: 'a.txt', content: 'A' },
    });
    await eventStore.append({
      type: 'approval_requested',
      runId: 'run-1',
      sessionId: 'session-1',
      approvalId: approval.id,
      toolCallId: 'call-write',
      toolId: 'Write',
      toolName: 'Write',
      displayName: 'Write File',
      input: { path: 'a.txt', content: 'A' },
    });
    await eventStore.append({
      type: 'tool_result',
      runId: 'run-1',
      sessionId: 'session-1',
      toolCallId: 'call-read',
      toolName: 'Read',
      content: 'A',
    });

    const state = buildRuntimeReplayState(
      await eventStore.list('session-1'),
      await approvalStore.list('session-1'),
      'session-1',
    );

    expect(state.toolCalls.map((call) => [call.toolCallId, call.status])).toEqual([
      ['call-write', 'pending_approval'],
      ['call-read', 'completed'],
    ]);
    expect(state.pendingApprovals.map((call) => call.approval?.id)).toEqual([approval.id]);
    expect(state.unclosedToolCalls.map((call) => call.toolCallId)).toEqual(['call-write']);
    expect(state.toolCallBatches).toHaveLength(1);
    expect(state.toolCallBatches[0]).toMatchObject({
      status: 'pending_approval',
      unclosedToolCalls: [expect.objectContaining({ toolCallId: 'call-write' })],
      pendingApprovals: [expect.objectContaining({ toolCallId: 'call-write' })],
    });
    expect(state.toolCallBatchByToolCallId.get('call-read')).toBe(state.toolCallBatches[0]);
  });

  it('consumes a pending approval only once inside one process', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'approval-store-'));
    cleanupDirs.add(cwd);
    const approvalStore = new FileApprovalStore(join(cwd, 'session.approvals.jsonl'));
    const approval = await approvalStore.create({
      sessionId: 'session-1',
      runId: 'run-1',
      toolCallId: 'call-write',
      toolId: 'Write',
      toolName: 'Write',
      input: { path: 'a.txt', content: 'A' },
    });

    const results = await Promise.all([
      approvalStore.resolvePending(approval.id, 'approved', 'first'),
      approvalStore.resolvePending(approval.id, 'approved', 'second'),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await approvalStore.get(approval.id))?.status).toBe('approved');
  });
});
