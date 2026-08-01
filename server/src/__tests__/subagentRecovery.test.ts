import { describe, expect, it, vi } from 'vitest';

import { reconcileInterruptedForegroundToolCalls } from '../runtime/subagent/recovery.js';
import type { RunRecord, RunStore } from '../runtime/runStore.js';
import type { SessionCatalog } from '../runtime/sessionCatalog.js';
import type { EventStore, PlatformEvent, PlatformEventInput } from '../runtime/types.js';

class MemoryEventStore implements EventStore {
  events: PlatformEvent[] = [];

  async append(event: PlatformEventInput): Promise<PlatformEvent> {
    const stored = {
      ...event,
      id: `event-${this.events.length + 1}`,
      timestamp: new Date().toISOString(),
    } as PlatformEvent;
    this.events.push(stored);
    return stored;
  }

  async appendBatch(events: PlatformEventInput[]): Promise<PlatformEvent[]> {
    const stored: PlatformEvent[] = [];
    for (const event of events) stored.push(await this.append(event));
    return stored;
  }

  async list(sessionId: string): Promise<PlatformEvent[]> {
    return this.events.filter((event) => !('sessionId' in event) || event.sessionId === sessionId);
  }
}

function childRun(status: RunRecord['status'] = 'running'): RunRecord {
  return {
    runId: 'child-run-1',
    sessionId: 'child-session-1',
    status,
    requestedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: { subagent: true },
  };
}

async function seedInterruptedAgentCall(eventStore: MemoryEventStore, includeStarted = true): Promise<void> {
  await eventStore.append({
    type: 'assistant_tool_calls',
    runId: 'parent-run-1',
    sessionId: 'parent-session-1',
    content: '',
    toolCalls: [{
      id: 'agent-call-1',
      name: 'Agent',
      arguments: JSON.stringify({ description: '最终安全复审', prompt: '检查实现' }),
    }],
  });
  await eventStore.append({
    type: 'tool_invocation_started',
    runId: 'parent-run-1',
    sessionId: 'parent-session-1',
    invocationId: 'parent-run-1:agent-call-1',
    toolCallId: 'agent-call-1',
    toolName: 'Agent',
    executionTarget: 'server-remote',
  });
  if (includeStarted) {
    await eventStore.append({
      type: 'subagent_started',
      runId: 'parent-run-1',
      sessionId: 'parent-session-1',
      toolCallId: 'agent-call-1',
      agentType: 'explore',
      description: '最终安全复审',
      childSessionId: 'child-session-1',
      childRunId: 'child-run-1',
      model: 'claude-opus-5[1m]',
    });
  }
}

describe('reconcileInterruptedForegroundToolCalls', () => {
  it('orphans the child and durably closes the parent Agent invocation without duplicates', async () => {
    const eventStore = new MemoryEventStore();
    await seedInterruptedAgentCall(eventStore);
    const child = childRun();
    const markStatus = vi.fn(async (_runId: string, status: RunRecord['status'], reason?: string) => {
      child.status = status;
      child.statusReason = reason;
      return child;
    });
    const runStore = {
      get: vi.fn(async () => child),
      markStatus,
    } as unknown as RunStore;
    const sessionCatalog = {
      markStatus: vi.fn(async () => undefined),
    } as unknown as SessionCatalog;

    const first = await reconcileInterruptedForegroundToolCalls({
      eventStore,
      runStore,
      sessionCatalog,
      parentSessionId: 'parent-session-1',
    });
    const second = await reconcileInterruptedForegroundToolCalls({
      eventStore,
      runStore,
      sessionCatalog,
      parentSessionId: 'parent-session-1',
    });

    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(markStatus).toHaveBeenCalledWith(
      'child-run-1',
      'orphaned',
      'subagent_parent_recovered_after_interruption',
      expect.objectContaining({ recoveredByParentToolCallId: 'agent-call-1' }),
    );
    expect(sessionCatalog.markStatus).toHaveBeenCalledWith('child-session-1', 'error');
    expect(eventStore.events.filter((event) => event.type === 'subagent_finished')).toHaveLength(1);
    expect(eventStore.events.find((event) => event.type === 'subagent_finished')).toMatchObject({
      toolCallId: 'agent-call-1',
      childRunId: 'child-run-1',
      status: 'cancelled',
    });
    expect(eventStore.events.filter((event) => event.type === 'tool_invocation_completed')).toHaveLength(1);
    expect(eventStore.events.find((event) => event.type === 'tool_invocation_completed')).toMatchObject({
      invocationId: 'parent-run-1:agent-call-1',
      status: 'cancelled',
    });
  });

  it('closes the parent invocation even if the process died before subagent_started was appended', async () => {
    const eventStore = new MemoryEventStore();
    await seedInterruptedAgentCall(eventStore, false);
    const runStore = {
      get: vi.fn(),
      markStatus: vi.fn(),
    } as unknown as RunStore;
    const sessionCatalog = {
      markStatus: vi.fn(),
    } as unknown as SessionCatalog;

    expect(await reconcileInterruptedForegroundToolCalls({
      eventStore,
      runStore,
      sessionCatalog,
      parentSessionId: 'parent-session-1',
    })).toBe(1);
    expect(runStore.get).not.toHaveBeenCalled();
    expect(sessionCatalog.markStatus).not.toHaveBeenCalled();
    expect(eventStore.events.filter((event) => event.type === 'subagent_finished')).toHaveLength(0);
    expect(eventStore.events.find((event) => event.type === 'tool_invocation_completed')).toMatchObject({
      toolCallId: 'agent-call-1',
      status: 'cancelled',
      error: expect.stringContaining('建立完成记录前中断'),
    });
  });

  it('closes an interrupted non-Agent foreground invocation immediately', async () => {
    const eventStore = new MemoryEventStore();
    await eventStore.append({
      type: 'assistant_tool_calls',
      runId: 'parent-run-1',
      sessionId: 'parent-session-1',
      content: '',
      toolCalls: [{ id: 'shell-call-1', name: 'Shell', arguments: '{"command":"sleep 30"}' }],
    });
    await eventStore.append({
      type: 'tool_invocation_started',
      runId: 'parent-run-1',
      sessionId: 'parent-session-1',
      invocationId: 'parent-run-1:shell-call-1',
      toolCallId: 'shell-call-1',
      toolName: 'Shell',
      executionTarget: 'server-remote',
    });

    const recovered = await reconcileInterruptedForegroundToolCalls({
      eventStore,
      sessionCatalog: { markStatus: vi.fn() } as unknown as SessionCatalog,
      parentSessionId: 'parent-session-1',
    });

    expect(recovered).toBe(1);
    expect(eventStore.events.find((event) => event.type === 'tool_invocation_completed')).toMatchObject({
      toolCallId: 'shell-call-1',
      toolName: 'Shell',
      status: 'cancelled',
      error: expect.stringContaining('Shell 执行完成前中断'),
    });
  });

  it('preserves a durable ask_user interaction that is still waiting for the user', async () => {
    const eventStore = new MemoryEventStore();
    await eventStore.append({
      type: 'assistant_tool_calls',
      runId: 'parent-run-1',
      sessionId: 'parent-session-1',
      content: '',
      toolCalls: [{ id: 'ask-call-1', name: 'AskUserQuestion', arguments: '{}' }],
    });
    await eventStore.append({
      type: 'tool_invocation_started',
      runId: 'parent-run-1',
      sessionId: 'parent-session-1',
      invocationId: 'parent-run-1:ask-call-1',
      toolCallId: 'ask-call-1',
      toolName: 'AskUserQuestion',
      executionTarget: 'server-local',
    });
    await eventStore.append({
      type: 'interaction_requested',
      runId: 'parent-run-1',
      sessionId: 'parent-session-1',
      invocationId: 'parent-run-1:ask-call-1',
      toolCallId: 'ask-call-1',
      interactionId: 'interaction-1',
      interactionType: 'ask_user',
    });

    expect(await reconcileInterruptedForegroundToolCalls({
      eventStore,
      sessionCatalog: { markStatus: vi.fn() } as unknown as SessionCatalog,
      parentSessionId: 'parent-session-1',
    })).toBe(0);
    expect(eventStore.events.filter((event) => event.type === 'tool_invocation_completed')).toHaveLength(0);
  });
});
