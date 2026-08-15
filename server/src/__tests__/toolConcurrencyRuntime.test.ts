/** drainToolCalls 并行窗：跨工具并发、串行边界与单调用回归。 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type {
  AuthorizedToolCall,
  ToolCallContext,
  ToolDescriptor,
  ToolResult,
  ToolRuntime,
} from '../agent/toolRuntime.js';
import { EventBackedApprovalStore } from '../runtime/approvalStore.js';
import { FileEventStore } from '../runtime/fileEventStore.js';
import { LegacyTranscriptProjection } from '../runtime/legacyTranscriptProjection.js';
import { RawAgentLoop } from '../runtime/rawAgentLoop.js';
import type { RunStore } from '../runtime/runStore.js';
import { InMemoryToolInvocationStore } from '../runtime/toolInvocationStore.js';
import type { ModelAdapter, ModelEvent, ModelRequest, RunContext } from '../runtime/types.js';
import type { OutboundEvent } from '../types/index.js';

async function collect(stream: AsyncIterable<OutboundEvent>): Promise<OutboundEvent[]> {
  const events: OutboundEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('drainToolCalls 通用并行窗', () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
    cleanupDirs.clear();
  });

  const agentDescriptor: ToolDescriptor = {
    id: 'Agent',
    name: 'Agent',
    displayName: 'Agent',
    description: 'spawn subagent',
    schema: z.object({ tag: z.string() }),
    risk: 'safe',
    approvalMode: 'never',
    concurrency: 'parallel',
    auditCategory: 'agent.subagent',
  };
  const readDescriptor: ToolDescriptor = {
    id: 'Read',
    name: 'Read',
    displayName: 'Read',
    description: 'read',
    schema: z.object({ path: z.string() }),
    risk: 'safe',
    approvalMode: 'never',
    concurrency: 'parallel',
    auditCategory: 'filesystem.read',
  };
  const serialDescriptor: ToolDescriptor = {
    id: 'SerialRead',
    name: 'SerialRead',
    displayName: 'Serial Read',
    description: 'safe but not concurrency opt-in',
    schema: z.object({ path: z.string() }),
    risk: 'safe',
    approvalMode: 'never',
    auditCategory: 'test.serial',
  };

  /**
   * opt-in 调用用 barrier 证并发重叠：预期数量的 invoke 必须同时在飞才能完成；
   * 串行执行会在 2s 超时上失败（防假绿）。
   */
  class BarrierToolRuntime implements ToolRuntime {
    readonly order: string[] = [];
    private started = 0;
    private releaseBarrier!: () => void;
    private readonly barrier = new Promise<void>((resolve) => { this.releaseBarrier = resolve; });

    constructor(private readonly expectedParallel: number) {}

    list(): ToolDescriptor[] {
      return [agentDescriptor, readDescriptor, serialDescriptor];
    }

    async invoke<TInput>(call: AuthorizedToolCall<TInput>, _context: ToolCallContext): Promise<ToolResult> {
      if (call.toolId === 'SerialRead') {
        const path = (call.input as { path: string }).path;
        this.order.push(`serial:${path}`);
        return { content: `serial-done:${path}` };
      }

      const tag = call.toolId === 'Agent'
        ? (call.input as { tag: string }).tag
        : (call.input as { path: string }).path;
      this.order.push(`start:${call.toolId}:${tag}`);
      this.started += 1;
      if (this.started >= this.expectedParallel) this.releaseBarrier();
      await Promise.race([
        this.barrier,
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('opt-in 工具没有并行执行（barrier 2s 超时）')), 2_000);
          timer.unref?.();
        }),
      ]);
      this.order.push(`end:${call.toolId}:${tag}`);
      return { content: `done:${tag}` };
    }
  }

  class BatchAdapter implements ModelAdapter {
    calls = 0;

    constructor(private readonly toolCalls: Array<{ id: string; name: string; arguments: string }>) {}

    async *stream(_request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
      this.calls += 1;
      if (this.calls === 1) {
        yield { type: 'completed', content: '', toolCalls: this.toolCalls };
        return;
      }
      yield { type: 'text_delta', content: '完成' };
      yield { type: 'completed', content: '完成', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
    }
  }

  async function runLoop(toolRuntime: ToolRuntime, adapter: ModelAdapter): Promise<OutboundEvent[]> {
    const cwd = await mkdtemp(join(tmpdir(), 'subagent-loop-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'));
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-par'),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime,
    });
    return collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat', content: '并行测试' },
        prompt: '并行测试',
        instructions: 'test',
        maxTurns: 3,
        connection: { apiKey: 'k', baseUrl: 'http://127.0.0.1:0' },
      },
      {
        runId: 'run-par',
        sessionId: 'session-par',
        model: 'mock-model',
        cwd,
        channelContext: { channel: 'web', user: { id: 'u', username: 'alice', role: 'user', tenantId: 'kaiyan' } },
      },
    ));
  }

  it('连续多个 Agent 调用并发执行，tool_result 仍按原顺序回填', async () => {
    const toolRuntime = new BarrierToolRuntime(2);
    const events = await runLoop(toolRuntime, new BatchAdapter([
      { id: 'c1', name: 'Agent', arguments: JSON.stringify({ tag: 'a1' }) },
      { id: 'c2', name: 'Agent', arguments: JSON.stringify({ tag: 'a2' }) },
    ]));

    const starts = toolRuntime.order.filter((entry) => entry.startsWith('start:'));
    expect(starts).toHaveLength(2);
    expect(toolRuntime.order.indexOf('end:Agent:a1')).toBeGreaterThan(
      toolRuntime.order.indexOf('start:Agent:a2'),
    );

    const results = events.filter((event) => event.type === 'tool_result');
    expect(results.map((event) => event.toolResult)).toEqual(['done:a1', 'done:a2']);
    expect(results.map((event) => event.toolId)).toEqual(['c1', 'c2']);
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });

  it('非 Agent 的 opt-in 工具也并发执行', async () => {
    const toolRuntime = new BarrierToolRuntime(2);
    const events = await runLoop(toolRuntime, new BatchAdapter([
      { id: 'c1', name: 'Read', arguments: JSON.stringify({ path: 'a.txt' }) },
      { id: 'c2', name: 'Read', arguments: JSON.stringify({ path: 'b.txt' }) },
    ]));

    expect(toolRuntime.order.indexOf('end:Read:a.txt')).toBeGreaterThan(
      toolRuntime.order.indexOf('start:Read:b.txt'),
    );
    const results = events.filter((event) => event.type === 'tool_result');
    expect(results.map((event) => event.toolResult)).toEqual(['done:a.txt', 'done:b.txt']);
    expect(results.map((event) => event.toolId)).toEqual(['c1', 'c2']);
  });

  it('duplicate workers 在并行窗先争同一 owner claim，不会拆分 invocation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'parallel-duplicate-worker-'));
    cleanupDirs.add(cwd);
    const sessionId = 'session-par-duplicate';
    const runId = 'run-par-duplicate';
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'));
    const toolInvocationStore = new InMemoryToolInvocationStore();
    const toolRuntime = new BarrierToolRuntime(2);
    const runStore = {
      get: vi.fn(async () => ({ status: 'running' })),
    } as unknown as RunStore;
    const calls = [
      { id: 'c1', name: 'Read', arguments: JSON.stringify({ path: 'a.txt' }) },
      { id: 'c2', name: 'Read', arguments: JSON.stringify({ path: 'b.txt' }) },
    ];
    const createLoop = (suffix: string) => new RawAgentLoop({
      modelAdapter: new BatchAdapter(calls),
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, sessionId),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, `session-${suffix}.jsonl`)),
      toolRuntime,
      toolInvocationStore,
      runStore,
    });
    const input = {
      message: { channel: 'web' as const, chatId: 'chat', content: '并行测试' },
      prompt: '并行测试',
      instructions: 'test',
      maxTurns: 3,
      connection: { apiKey: 'k', baseUrl: 'http://127.0.0.1:0' },
    };
    const context: RunContext = {
      runId,
      sessionId,
      model: 'mock-model',
      cwd,
      channelContext: { channel: 'web', user: { id: 'u', username: 'alice', role: 'user', tenantId: 'kaiyan' } },
    };

    const [first, second] = await Promise.all([
      collect(createLoop('first').run(input, context)),
      collect(createLoop('second').run(input, { ...context })),
    ]);

    expect(toolRuntime.order.filter((entry) => entry.startsWith('start:'))).toHaveLength(2);
    await expect(toolInvocationStore.get(`${runId}:c1`)).resolves.toMatchObject({ status: 'completed' });
    await expect(toolInvocationStore.get(`${runId}:c2`)).resolves.toMatchObject({ status: 'completed' });
    expect([...first, ...second].some((event) => event.type === 'error')).toBe(false);
    const lifecycle = await eventStore.list(sessionId);
    expect(lifecycle.filter((event) => event.type === 'tool_invocation_started')).toHaveLength(2);
    expect(lifecycle.filter((event) => event.type === 'tool_invocation_completed')).toHaveLength(2);
    expect(lifecycle.some((event) => event.type === 'run_finished' && event.subtype === 'error')).toBe(false);
  });

  it('不同的 opt-in 工具可进入同一并行窗', async () => {
    const toolRuntime = new BarrierToolRuntime(3);
    const events = await runLoop(toolRuntime, new BatchAdapter([
      { id: 'c1', name: 'Agent', arguments: JSON.stringify({ tag: 'a1' }) },
      { id: 'c2', name: 'Agent', arguments: JSON.stringify({ tag: 'a2' }) },
      { id: 'c3', name: 'Read', arguments: JSON.stringify({ path: 'x.txt' }) },
    ]));

    const starts = toolRuntime.order.filter((entry) => entry.startsWith('start:'));
    expect(starts).toHaveLength(3);
    expect(toolRuntime.order.findIndex((entry) => entry.startsWith('end:'))).toBeGreaterThan(2);
    const results = events.filter((event) => event.type === 'tool_result');
    expect(results.map((event) => event.toolResult)).toEqual(['done:a1', 'done:a2', 'done:x.txt']);
  });

  it('未 opt-in 的 safe 工具保持串行并切断并行窗', async () => {
    const toolRuntime = new BarrierToolRuntime(2);
    const events = await runLoop(toolRuntime, new BatchAdapter([
      { id: 'c1', name: 'Agent', arguments: JSON.stringify({ tag: 'a1' }) },
      { id: 'c2', name: 'Read', arguments: JSON.stringify({ path: 'x.txt' }) },
      { id: 'c3', name: 'SerialRead', arguments: JSON.stringify({ path: 'later.txt' }) },
    ]));

    const serialIndex = toolRuntime.order.indexOf('serial:later.txt');
    expect(serialIndex).toBeGreaterThan(toolRuntime.order.indexOf('end:Agent:a1'));
    expect(serialIndex).toBeGreaterThan(toolRuntime.order.indexOf('end:Read:x.txt'));
    const results = events.filter((event) => event.type === 'tool_result');
    expect(results.map((event) => event.toolResult)).toEqual(['done:a1', 'done:x.txt', 'serial-done:later.txt']);
  });

  it('单个 opt-in 调用行为与串行路径一致', async () => {
    const toolRuntime = new BarrierToolRuntime(1);
    const events = await runLoop(toolRuntime, new BatchAdapter([
      { id: 'c1', name: 'Read', arguments: JSON.stringify({ path: 'solo.txt' }) },
    ]));
    const results = events.filter((event) => event.type === 'tool_result');
    expect(results.map((event) => event.toolResult)).toEqual(['done:solo.txt']);
  });
});
