import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  writeFileToolDescriptor,
  type AuthorizedToolCall,
  type ToolCallContext,
  type ToolDescriptor,
  type ToolResult,
  type ToolRuntime,
} from '../agent/toolRuntime.js';
import { EventBackedApprovalStore } from '../runtime/approvalStore.js';
import { FileEventStore } from '../runtime/fileEventStore.js';
import { LegacyTranscriptProjection } from '../runtime/legacyTranscriptProjection.js';
import { RawAgentLoop } from '../runtime/rawAgentLoop.js';
import { AutomationFenceRejectedError, type SessionAutomationRuntimeGuard } from '../runtime/sessionAutomationRuntimeGuard.js';
import type { ModelAdapter, ModelEvent, RunContext } from '../runtime/types.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

class CountingToolRuntime implements ToolRuntime {
  invocations = 0;
  list(): ToolDescriptor[] { return [writeFileToolDescriptor]; }
  async invoke<TInput>(_call: AuthorizedToolCall<TInput>, _context: ToolCallContext): Promise<ToolResult> {
    this.invocations += 1;
    return { content: 'unexpected execution' };
  }
}

const automationFence = {
  automationId: '11111111-1111-4111-8111-111111111111',
  incarnationId: '22222222-2222-4222-8222-222222222222',
  generation: 1,
  specVersion: 1,
  executionId: '33333333-3333-4333-8333-333333333333',
  runId: 'run-automation-gate',
  rootSessionId: 'session-automation-gate',
};

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of stream) { /* drain */ }
}

describe('RawAgentLoop session automation live gate placement', () => {
  const cleanup = new Set<string>();
  afterEach(async () => {
    await Promise.all([...cleanup].map(path => rm(path, { recursive: true, force: true })));
    cleanup.clear();
  });

  async function createLoop(adapter: ModelAdapter, guard: SessionAutomationRuntimeGuard, toolRuntime = new CountingToolRuntime()) {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-automation-gate-'));
    cleanup.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'events.jsonl'), DEFAULT_TENANT_ID);
    return {
      cwd,
      toolRuntime,
      loop: new RawAgentLoop({
        modelAdapter: adapter,
        eventStore,
        approvalStore: new EventBackedApprovalStore(eventStore, automationFence.rootSessionId, DEFAULT_TENANT_ID),
        transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'transcript.jsonl')),
        toolRuntime,
        automationGuard: guard,
      }),
    };
  }

  function runContext(cwd: string): RunContext {
    return {
      runId: automationFence.runId,
      sessionId: automationFence.rootSessionId,
      tenantId: DEFAULT_TENANT_ID,
      model: 'gpt-5.5',
      cwd,
      automationFence,
      channelContext: { channel: 'web', user: { id: 'admin-1', username: 'admin', role: 'admin' } },
      approvalPolicy: { autoApproveTools: true },
      hooks: { onInteraction: async () => ({ allow: true, message: 'ok' }) },
    };
  }

  const input = {
    message: { channel: 'web' as const, chatId: 'chat-1', content: 'continue' },
    prompt: 'continue', instructions: 'continue', maxTurns: 2,
    connection: { apiKey: 'test', baseUrl: 'https://example.invalid/v1' },
  };

  it('blocks admission while disabled and recovers after reopening', async () => {
    let enabled = false;
    const stream = vi.fn(async function* (): AsyncIterable<ModelEvent> {
      yield { type: 'completed', content: 'ok', toolCalls: [] };
    });
    const guard = {
      beforeModel: vi.fn(async () => {
        if (!enabled) throw new AutomationFenceRejectedError('execution_disabled');
      }),
      finishModel: vi.fn(), barrier: vi.fn(),
    } as unknown as SessionAutomationRuntimeGuard;
    const { loop, cwd } = await createLoop({ stream }, guard);

    await expect(drain(loop.run(input, runContext(cwd)))).resolves.toBeUndefined();
    expect(stream).not.toHaveBeenCalled();
    expect(guard.beforeModel).toHaveBeenCalledTimes(1);

    enabled = true;
    await expect(drain(loop.run(input, runContext(cwd)))).resolves.toBeUndefined();
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('re-gates in the production adapter hook after admission and before transport', async () => {
    let enabled = true;
    const stream = vi.fn(async function* (_request, context: RunContext): AsyncIterable<ModelEvent> {
      await context.authorizeModelTurn?.();
      yield { type: 'completed', content: 'must not send', toolCalls: [] };
    });
    const handle = {
      providerAttemptId: '55555555-5555-4555-8555-555555555555', reservationIds: [],
      sourceKey: 'model:gate', model: 'gpt-5.5', purpose: 'work' as const,
    };
    const guard = {
      beforeModel: vi.fn(async () => { enabled = false; return handle; }),
      beforeModelTransport: vi.fn(async () => {
        if (!enabled) throw new AutomationFenceRejectedError('execution_disabled');
      }),
      finishModel: vi.fn(), barrier: vi.fn(), releaseModel: vi.fn(),
    } as unknown as SessionAutomationRuntimeGuard;
    const { loop, cwd } = await createLoop({ stream }, guard);

    await drain(loop.run(input, runContext(cwd))).catch(() => undefined);
    expect(guard.beforeModelTransport).toHaveBeenCalledWith(expect.anything(), handle, true);
    expect(guard.finishModel).toHaveBeenCalledWith(expect.anything(), handle, undefined, expect.anything());
  });

  it('calls barrier after model output but before every tool side effect', async () => {
    let enabled = true;
    const adapter: ModelAdapter = {
      async *stream(): AsyncIterable<ModelEvent> {
        yield {
          type: 'completed', content: '',
          toolCalls: [{ id: 'call-write', name: 'Write', arguments: '{"path":"blocked.txt","content":"no"}' }],
        };
        enabled = false;
      },
    };
    const guard = {
      beforeModel: vi.fn(async () => undefined),
      finishModel: vi.fn(async () => undefined),
      barrier: vi.fn(async () => {
        if (!enabled) throw new AutomationFenceRejectedError('execution_disabled');
      }),
    } as unknown as SessionAutomationRuntimeGuard;
    const { loop, cwd, toolRuntime } = await createLoop(adapter, guard);

    await drain(loop.run(input, runContext(cwd))).catch(() => undefined);
    expect(guard.barrier).toHaveBeenCalled();
    expect(toolRuntime.invocations).toBe(0);
  });
});
