import { readFileSync } from 'fs';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBuiltinTools } from '../agent/builtinTools.js';
import { PlatformToolRuntime } from '../agent/toolRuntime.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { EventBackedApprovalStore } from '../runtime/approvalStore.js';
import { FileEventStore } from '../runtime/fileEventStore.js';
import { LegacyTranscriptProjection } from '../runtime/legacyTranscriptProjection.js';
import { RawAgentLoop } from '../runtime/rawAgentLoop.js';
import type { RunStore } from '../runtime/runStore.js';
import { InMemoryToolInvocationStore } from '../runtime/toolInvocationStore.js';
import type { ModelAdapter, ModelEvent, ModelRequest, ModelToolCall, RunContext } from '../runtime/types.js';
import type { OutboundEvent } from '../types/index.js';

class StaticToolCallsAdapter implements ModelAdapter {
  constructor(private readonly toolCalls: ModelToolCall[]) {}
  async *stream(_request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    yield { type: 'completed', content: '', toolCalls: this.toolCalls };
  }
}

class AskUserAndReadAdapter implements ModelAdapter {
  async *stream(_request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    yield {
      type: 'completed', content: '', toolCalls: [
        {
          id: 'call_ask_batch', name: 'AskUserQuestion',
          arguments: JSON.stringify({ questions: [{
            question: 'Which branch should I use?', header: 'Branch', multiSelect: false,
            options: [{ label: 'main', description: 'Use main' }, { label: 'dev', description: 'Use dev' }],
          }] }),
        },
        { id: 'call_ask_read', name: 'Read', arguments: JSON.stringify({ path: 'seed.txt' }) },
      ],
    };
  }
}

class UnexpectedModelAdapter implements ModelAdapter {
  async *stream(): AsyncIterable<ModelEvent> { throw new Error('model must not run after claim loss'); }
}

const cleanupDirs = new Set<string>();
afterEach(async () => {
  await Promise.all([...cleanupDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  cleanupDirs.clear();
});

async function collect(iterable: AsyncIterable<OutboundEvent>): Promise<OutboundEvent[]> {
  const events: OutboundEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

async function claimInvocation(input: {
  store: InMemoryToolInvocationStore;
  invocationId: string;
  runId: string;
  sessionId: string;
  toolCallId: string;
}): Promise<void> {
  await input.store.start({
    invocationId: input.invocationId, runId: input.runId, sessionId: input.sessionId,
    toolCallId: input.toolCallId, toolName: 'Read', executionTarget: 'server-local',
  });
  await input.store.invokeWithActiveRunGate(
    input.runId,
    input.invocationId,
    async () => 'winner-started',
    async () => 'running',
  );
  const claimed = await input.store.get(input.invocationId);
  expect(claimed?.metadata.invokeClaimedAt).toEqual(expect.any(String));
  expect(claimed?.metadata).not.toHaveProperty('invokeClaimedByWorkerId');
}

function expectNoClaimLoserLifecycle(
  events: Awaited<ReturnType<FileEventStore['list']>>,
  toolCallId: string,
): void {
  expect(events.some((event) => event.type === 'tool_invocation_started' && event.toolCallId === toolCallId)).toBe(false);
  expect(events.some((event) => event.type === 'tool_invocation_completed' && event.toolCallId === toolCallId)).toBe(false);
}

function staleClaimRunStore(runId: string, sessionId: string): RunStore {
  return {
    get: async () => ({
      runId,
      sessionId,
      status: 'running',
      workerId: 'worker-after-crash',
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      requestedAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:01:00.000Z',
      metadata: {},
    }),
  } as unknown as RunStore;
}

describe('RawAgentLoop claimed invocation resume recovery', () => {
  it('lease loser entering an unclaimed gate exits silently without tool side effects or run_finished', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-lease-loser-'));
    cleanupDirs.add(cwd);
    await writeFile(join(cwd, 'seed.txt'), 'SEED_OK', 'utf-8');
    const sessionId = 'session-lease-loser';
    const runId = 'run-lease-loser';
    const toolCallId = 'call_lease_loser_read';
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const toolInvocationStore = new InMemoryToolInvocationStore();
    const runStore = {
      get: async () => ({
        runId,
        sessionId,
        status: 'running',
        workerId: 'worker-winner',
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        requestedAt: '2026-08-16T00:00:00.000Z',
        updatedAt: '2026-08-16T00:01:00.000Z',
        metadata: {},
      }),
    } as unknown as RunStore;
    const loop = new RawAgentLoop({
      modelAdapter: new StaticToolCallsAdapter([
        { id: toolCallId, name: 'Read', arguments: JSON.stringify({ path: 'seed.txt' }) },
      ]),
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, sessionId, DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new PlatformToolRuntime({ providers: [createBuiltinTools()] }),
      toolInvocationStore,
      runStore,
    });

    const outbound = await collect(loop.run({
      message: { channel: 'web', chatId: 'chat-1', content: '读取文件' },
      prompt: '读取文件',
      instructions: '必须调用 Read。',
      maxTurns: 4,
      connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
    }, {
      runId,
      sessionId,
      model: 'gpt-5.5',
      cwd,
      workerId: 'worker-loser',
      channelContext: { channel: 'web', user: { id: 'admin-1', username: 'admin', role: 'admin' } },
    }));

    expect(outbound.some((event) => event.type === 'error')).toBe(false);
    const lifecycle = await eventStore.list(DEFAULT_TENANT_ID, sessionId);
    expectNoClaimLoserLifecycle(lifecycle, toolCallId);
    expect(lifecycle.some((event) => event.type === 'run_finished')).toBe(false);
    await expect(toolInvocationStore.get(`${runId}:${toolCallId}`)).resolves.toMatchObject({
      status: 'running',
      metadata: { workerId: 'worker-loser' },
    });
  });

  it('fails an authoritative run durably for an ownerless legacy claim without replaying its tool', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-run-claimed-'));
    cleanupDirs.add(cwd);
    await writeFile(join(cwd, 'seed.txt'), 'SEED_OK', 'utf-8');
    const sessionId = 'session-run-claimed';
    const runId = 'run-claimed';
    const toolCallId = 'call_claimed_read';
    const invocationId = `${runId}:${toolCallId}`;
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const toolInvocationStore = new InMemoryToolInvocationStore();
    await claimInvocation({ store: toolInvocationStore, invocationId, runId, sessionId, toolCallId });
    const loop = new RawAgentLoop({
      modelAdapter: new StaticToolCallsAdapter([
        { id: toolCallId, name: 'Read', arguments: JSON.stringify({ path: 'seed.txt' }) },
      ]),
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, sessionId, DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new PlatformToolRuntime({ providers: [createBuiltinTools()] }),
      toolInvocationStore,
      runStore: staleClaimRunStore(runId, sessionId),
    });

    const outbound = await collect(loop.run({
      message: { channel: 'web', chatId: 'chat-1', content: '读取文件' },
      prompt: '读取文件',
      instructions: '必须调用 Read。',
      maxTurns: 4,
      connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
    }, {
      runId, sessionId, model: 'gpt-5.5', cwd, workerId: 'worker-after-crash',
      channelContext: { channel: 'web', user: { id: 'admin-1', username: 'admin', role: 'admin' } },
    }));

    const claimFailure = `tool invocation already claimed by another worker: ${invocationId}`;
    expect(outbound.at(-1)).toEqual({ type: 'error', error: claimFailure });
    const lifecycle = await eventStore.list(DEFAULT_TENANT_ID, sessionId);
    expectNoClaimLoserLifecycle(lifecycle, toolCallId);
    expect(lifecycle).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'run_finished', subtype: 'error', error: claimFailure }),
    ]));
  });

  it('fails approval resume durably for an ownerless legacy claim without replaying its sibling', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-approval-resume-claimed-'));
    cleanupDirs.add(cwd);
    await writeFile(join(cwd, 'seed.txt'), 'SEED_OK', 'utf-8');
    const sessionId = 'session-approval-resume-claimed';
    const runId = 'run-approval-resume-claimed';
    const claimedToolCallId = 'call_claimed_read_after_approval';
    const invocationId = `${runId}:${claimedToolCallId}`;
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const transcriptPath = join(cwd, 'session.jsonl');
    const toolInvocationStore = new InMemoryToolInvocationStore();
    const approvalStore = new EventBackedApprovalStore(eventStore, sessionId, DEFAULT_TENANT_ID);
    const firstLoop = new RawAgentLoop({
      modelAdapter: new StaticToolCallsAdapter([
        { id: 'call_approved_write', name: 'Write', arguments: JSON.stringify({ path: 'approved.txt', content: 'APPROVED_OK' }) },
        { id: claimedToolCallId, name: 'Read', arguments: JSON.stringify({ path: 'seed.txt' }) },
      ]),
      eventStore, approvalStore, transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime(), toolInvocationStore,
    });

    let approvalId = '';
    const approvalRequested = new Promise<void>((resolve) => {
      const iterator = firstLoop.run({
        message: { channel: 'web', chatId: 'chat-1', content: '写后读' }, prompt: '写后读',
        instructions: '必须调用工具。', maxTurns: 4,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      }, {
        runId, sessionId, model: 'gpt-5.5', cwd,
        channelContext: { channel: 'web', user: { id: 'admin-1', username: 'admin', role: 'admin' } },
        hooks: { onInteraction: async (event) => {
          approvalId = event.interactionId; resolve(); return new Promise(() => {});
        } },
      })[Symbol.asyncIterator]();
      void iterator.next();
    });
    await approvalRequested;
    await claimInvocation({ store: toolInvocationStore, invocationId, runId, sessionId, toolCallId: claimedToolCallId });

    const rebuiltLoop = new RawAgentLoop({
      modelAdapter: new UnexpectedModelAdapter(), eventStore, approvalStore,
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime(), toolInvocationStore,
      runStore: staleClaimRunStore(runId, sessionId),
    });
    const outbound = await collect(rebuiltLoop.resumeApproval({
      approvalId, response: { allow: true, message: 'ok' }, instructions: '继续。', maxTurns: 4,
    }, {
      runId, sessionId, model: 'gpt-5.5', cwd, workerId: 'worker-after-crash',
      channelContext: { channel: 'web', user: { id: 'admin-1', username: 'admin', role: 'admin' } },
    }));

    const claimFailure = `tool invocation already claimed by another worker: ${invocationId}`;
    expect(readFileSync(join(cwd, 'approved.txt'), 'utf-8')).toBe('APPROVED_OK');
    expect(outbound.at(-1)).toEqual({ type: 'error', error: claimFailure });
    await expect(toolInvocationStore.get(invocationId)).resolves.toMatchObject({ status: 'running' });
    const lifecycle = await eventStore.list(DEFAULT_TENANT_ID, sessionId);
    expectNoClaimLoserLifecycle(lifecycle, claimedToolCallId);
    expect(lifecycle).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'run_finished', subtype: 'error', error: claimFailure }),
    ]));
  });

  it('fails interaction resume durably for an ownerless legacy claim without replaying its sibling', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-interaction-resume-claimed-'));
    cleanupDirs.add(cwd);
    await writeFile(join(cwd, 'seed.txt'), 'SEED_OK', 'utf-8');
    const sessionId = 'session-interaction-resume-claimed';
    const runId = 'run-interaction-resume-claimed';
    const claimedToolCallId = 'call_ask_read';
    const invocationId = `${runId}:${claimedToolCallId}`;
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const transcriptPath = join(cwd, 'session.jsonl');
    const toolInvocationStore = new InMemoryToolInvocationStore();
    const firstLoop = new RawAgentLoop({
      modelAdapter: new AskUserAndReadAdapter(), eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, sessionId, DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime({ providers: [createBuiltinTools()] }), toolInvocationStore,
    });

    let interactionId = '';
    const interactionRequested = new Promise<void>((resolve) => {
      const iterator = firstLoop.run({
        message: { channel: 'web', chatId: 'chat-1', content: '先问再读' }, prompt: '先问再读',
        instructions: '必须调用 AskUserQuestion 和 Read。', maxTurns: 4,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      }, {
        runId, sessionId, model: 'gpt-5.5', cwd,
        channelContext: { channel: 'web', user: { id: 'admin-1', username: 'admin', role: 'admin' } },
        hooks: { onInteraction: async (event) => {
          interactionId = event.interactionId;
          await eventStore.append({
            type: 'interaction_requested', sessionId, runId: event.runId,
            toolCallId: event.toolCallId, invocationId: event.invocationId, interactionId,
            interactionType: 'ask_user', userId: 'admin-1', toolId: event.toolId,
            toolName: event.toolName, displayName: event.displayName, questions: event.questions,
          }, { tenantId: DEFAULT_TENANT_ID });
          resolve(); return new Promise(() => {});
        } },
      })[Symbol.asyncIterator]();
      void iterator.next();
    });
    await interactionRequested;
    await eventStore.append({
      type: 'interaction_resolved', sessionId, runId, toolCallId: 'call_ask_batch',
      invocationId: `${runId}:call_ask_batch`, interactionId, interactionType: 'ask_user',
      userId: 'admin-1', response: { answers: { branch: 'main' }, message: 'Use main' },
    }, { tenantId: DEFAULT_TENANT_ID });
    await claimInvocation({ store: toolInvocationStore, invocationId, runId, sessionId, toolCallId: claimedToolCallId });

    const rebuiltLoop = new RawAgentLoop({
      modelAdapter: new UnexpectedModelAdapter(), eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, sessionId, DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime({ providers: [createBuiltinTools()] }), toolInvocationStore,
      runStore: staleClaimRunStore(runId, sessionId),
    });
    const outbound = await collect(rebuiltLoop.resumeInteraction({
      interactionId, response: { answers: { branch: 'main' }, message: 'Use main' },
      instructions: '继续。', maxTurns: 4,
    }, {
      runId, sessionId, model: 'gpt-5.5', cwd, workerId: 'worker-after-crash',
      channelContext: { channel: 'web', user: { id: 'admin-1', username: 'admin', role: 'admin' } },
    }));

    const claimFailure = `tool invocation already claimed by another worker: ${invocationId}`;
    expect(outbound.at(-1)).toEqual({ type: 'error', error: claimFailure });
    await expect(toolInvocationStore.get(invocationId)).resolves.toMatchObject({ status: 'running' });
    const lifecycle = await eventStore.list(DEFAULT_TENANT_ID, sessionId);
    expectNoClaimLoserLifecycle(lifecycle, claimedToolCallId);
    expect(lifecycle).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'run_finished', subtype: 'error', error: claimFailure }),
    ]));
  });
});
