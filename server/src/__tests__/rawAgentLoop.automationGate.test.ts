import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBuiltinTools } from '../agent/builtinTools.js';
import {
  PlatformToolRuntime,
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
import { InMemoryToolInvocationStore } from '../runtime/toolInvocationStore.js';
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
      eventStore,
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

  it('approval resume keeps approval pending and fences audit/start, tools, and models', async () => {
    let approvalId = '';
    let resolveApproval!: () => void;
    const approvalRequested = new Promise<void>(resolve => { resolveApproval = resolve; });
    let modelCalls = 0;
    const adapter: ModelAdapter = {
      async *stream(): AsyncIterable<ModelEvent> {
        modelCalls += 1;
        if (modelCalls === 1) {
          yield { type: 'completed', content: '', toolCalls: [{ id: 'call-approved-write', name: 'Write', arguments: '{"path":"blocked.txt","content":"no"}' }] };
          return;
        }
        yield { type: 'completed', content: 'must not send', toolCalls: [] };
      },
    };
    let enabled = true;
    const guard = {
      beforeModel: vi.fn(async () => undefined), finishModel: vi.fn(async () => undefined),
      barrier: vi.fn(async () => { if (!enabled) throw new AutomationFenceRejectedError('status_paused'); }),
    } as unknown as SessionAutomationRuntimeGuard;
    const { loop, cwd, eventStore, toolRuntime } = await createLoop(adapter, guard);
    const context = runContext(cwd);
    context.approvalPolicy = { autoApproveTools: false };
    context.hooks = { onInteraction: async event => {
      approvalId = event.interactionId;
      resolveApproval();
      return new Promise(() => {});
    } };
    const iterator = loop.run(input, context)[Symbol.asyncIterator]();
    void iterator.next();
    await approvalRequested;

    const resumedModel = vi.fn(async function* (): AsyncIterable<ModelEvent> {
      yield { type: 'completed', content: 'must not send', toolCalls: [] };
    });
    const resumedApprovalStore = new EventBackedApprovalStore(
      eventStore, automationFence.rootSessionId, DEFAULT_TENANT_ID,
    );
    const invocationStore = new InMemoryToolInvocationStore();
    const invocationStart = vi.spyOn(invocationStore, 'start');
    const resumedLoop = new RawAgentLoop({
      modelAdapter: { stream: resumedModel }, eventStore,
      approvalStore: resumedApprovalStore,
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'transcript.jsonl')),
      toolRuntime, toolInvocationStore: invocationStore, automationGuard: guard,
    });
    enabled = false;
    await expect(drain(resumedLoop.resumeApproval({ approvalId, response: { allow: true }, instructions: 'continue', maxTurns: 2 }, context)))
      .rejects.toBeInstanceOf(AutomationFenceRejectedError);
    expect(guard.barrier).toHaveBeenCalledTimes(1);
    expect(await resumedApprovalStore.get(approvalId)).toMatchObject({ status: 'pending' });
    expect(invocationStart).not.toHaveBeenCalled();
    const durableEvents = await eventStore.list(DEFAULT_TENANT_ID, automationFence.rootSessionId);
    expect(durableEvents.some(event => event.type === 'tool_invocation_started')).toBe(false);
    expect(toolRuntime.invocations).toBe(0);
    expect(resumedModel).not.toHaveBeenCalled();
  });

  it('interaction resume revalidates before completion record and any next model request', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-automation-interaction-'));
    cleanup.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'events.jsonl'), DEFAULT_TENANT_ID);
    let interactionId = '';
    let resolveInteraction!: () => void;
    const interactionRequested = new Promise<void>(resolve => { resolveInteraction = resolve; });
    let modelCalls = 0;
    const adapter: ModelAdapter = { async *stream(): AsyncIterable<ModelEvent> {
      modelCalls += 1;
      if (modelCalls === 1) {
        yield { type: 'completed', content: '', toolCalls: [{ id: 'call-ask', name: 'AskUserQuestion', arguments: '{"questions":[{"question":"Continue?","header":"Choice","options":[{"label":"Yes","description":"Continue"},{"label":"No","description":"Stop"}],"multiSelect":false}]}' }] };
        return;
      }
      yield { type: 'completed', content: 'must not send', toolCalls: [] };
    } };
    let enabled = true;
    const guard = {
      beforeModel: vi.fn(async () => undefined), finishModel: vi.fn(async () => undefined), barrier: vi.fn(),
      recordInteraction: vi.fn(async () => { if (!enabled) throw new AutomationFenceRejectedError('generation_mismatch'); }),
    } as unknown as SessionAutomationRuntimeGuard;
    const loop = new RawAgentLoop({
      modelAdapter: adapter, eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, automationFence.rootSessionId, DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'transcript.jsonl')),
      toolRuntime: new PlatformToolRuntime({ providers: [createBuiltinTools()] }), automationGuard: guard,
    });
    const context = runContext(cwd);
    context.hooks = { onInteraction: async event => {
      interactionId = event.interactionId;
      await eventStore.append({
        type: 'interaction_requested', sessionId: context.sessionId, runId: context.runId,
        toolCallId: event.toolCallId, invocationId: event.invocationId, interactionId,
        interactionType: 'ask_user', userId: 'admin-1', toolId: event.toolId,
        toolName: event.toolName, displayName: event.displayName, questions: event.questions,
      }, { tenantId: DEFAULT_TENANT_ID });
      resolveInteraction();
      return new Promise(() => {});
    } };
    const iterator = loop.run(input, context)[Symbol.asyncIterator]();
    void iterator.next();
    await interactionRequested;
    await eventStore.append({
      type: 'interaction_resolved', sessionId: context.sessionId, runId: context.runId,
      toolCallId: 'call-ask', interactionId, interactionType: 'ask_user', userId: 'admin-1',
      response: { answers: { Choice: 'Yes' } },
    }, { tenantId: DEFAULT_TENANT_ID });

    const resumedModel = vi.fn(async function* (): AsyncIterable<ModelEvent> {
      yield { type: 'completed', content: 'must not send', toolCalls: [] };
    });
    const resumedLoop = new RawAgentLoop({
      modelAdapter: { stream: resumedModel }, eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, automationFence.rootSessionId, DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'transcript.jsonl')),
      toolRuntime: new PlatformToolRuntime({ providers: [createBuiltinTools()] }), automationGuard: guard,
    });
    enabled = false;
    await expect(drain(resumedLoop.resumeInteraction({ interactionId, response: { answers: { Choice: 'Yes' } }, instructions: 'continue', maxTurns: 2 }, context)))
      .rejects.toBeInstanceOf(AutomationFenceRejectedError);
    expect(guard.recordInteraction).toHaveBeenCalledTimes(2);
    expect(resumedModel).not.toHaveBeenCalled();
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
