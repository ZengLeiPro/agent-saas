import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PlatformToolRuntime, type ToolProvider } from '../agent/toolRuntime.js';
import { EventBackedApprovalStore } from '../runtime/approvalStore.js';
import { FileEventStore } from '../runtime/fileEventStore.js';
import { LegacyTranscriptProjection } from '../runtime/legacyTranscriptProjection.js';
import { RawAgentLoop } from '../runtime/rawAgentLoop.js';
import type { ModelAdapter, ModelEvent, ModelRequest, RunContext } from '../runtime/types.js';
import type { OutboundEvent } from '../types/index.js';

class PartialPolicyFailureAdapter implements ModelAdapter {
  calls = 0;

  async *stream(_request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    this.calls += 1;
    yield {
      type: 'completed',
      content: '已生成的策略报告正文',
      toolCalls: [],
      terminalStatus: 'failed',
      errorCode: 'cyber_policy',
      errorMessage: 'Responses API HTTP 200: cyber_policy',
      modelRequestId: 'request-policy',
      attemptId: 'attempt-policy',
      emittedOutputCount: 1,
      providerStatus: 200,
      failureKind: 'policy_rejection',
      recoveryAction: 'switch_model',
    };
  }
}

class MultiTurnPolicyFailureAdapter implements ModelAdapter {
  calls = 0;

  async *stream(_request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    this.calls += 1;
    if (this.calls === 1) {
      yield { type: 'text_delta', content: '前一轮正文' };
      yield {
        type: 'completed',
        content: '前一轮正文',
        toolCalls: [{ id: 'call-check', name: 'Check', arguments: '{}' }],
      };
      return;
    }
    yield {
      type: 'completed',
      content: '当前轮部分正文',
      toolCalls: [],
      terminalStatus: 'failed',
      errorCode: 'cyber_policy',
      errorMessage: 'Responses API HTTP 200: cyber_policy',
      modelRequestId: 'request-policy-2',
      attemptId: 'attempt-policy-2',
      emittedOutputCount: 1,
      providerStatus: 200,
      failureKind: 'policy_rejection',
      recoveryAction: 'switch_model',
    };
  }
}

const checkToolProvider: ToolProvider = {
  list: () => [{
    id: 'Check', name: 'Check', displayName: '检查', description: '测试工具', schema: z.object({}),
    risk: 'safe', approvalMode: 'never', auditCategory: 'test.check',
  }],
  invoke: async (call) => call.toolId === 'Check' ? { content: '检查完成' } : undefined,
};

class PartialOrdinaryFailureAdapter implements ModelAdapter {
  async *stream(_request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    yield {
      type: 'completed', content: '普通失败的候选正文', toolCalls: [], terminalStatus: 'failed',
      errorCode: 'other_permanent', errorMessage: 'ordinary permanent failure', modelRequestId: 'request-ordinary',
      attemptId: 'attempt-ordinary', emittedOutputCount: 1, providerStatus: 400,
    };
  }
}

async function collect(stream: AsyncIterable<OutboundEvent>): Promise<OutboundEvent[]> {
  const events: OutboundEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('RawAgentLoop policy failure', () => {
  const cleanupDirs = new Set<string>();
  afterEach(async () => {
    for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
    cleanupDirs.clear();
  });

  it('保留部分正文并输出结构化换模恢复动作', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-policy-error-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'));
    const adapter = new PartialPolicyFailureAdapter();
    const onResult = vi.fn();
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-policy-error'),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new PlatformToolRuntime(),
    });

    const events = await collect(loop.run({
      message: { channel: 'web', chatId: 'chat-1', content: '写一份策略报告' },
      prompt: '写一份策略报告',
      instructions: '完成任务。',
      maxTurns: 1,
      connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
    }, {
      runId: 'run-policy-error',
      sessionId: 'session-policy-error',
      model: 'gpt-5.6-sol',
      cwd,
      channelContext: { channel: 'web', outputTransactionMode: 'terminal_buffered', user: { id: 'admin-1', username: 'admin', role: 'admin' } },
      hooks: { onResult },
    }));

    expect(adapter.calls).toBe(1);
    expect(events.at(-1)).toEqual({
      type: 'error',
      error: '当前模型受策略限制，请切换其他模型继续。',
      runId: 'run-policy-error',
      failureKind: 'policy_rejection',
      recoveryAction: 'switch_model',
    });
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({
      subtype: 'error', failureKind: 'policy_rejection', recoveryAction: 'switch_model',
    }));
    const persisted = await eventStore.list('session-policy-error');
    expect(persisted.find((event) => event.type === 'assistant_message')).toMatchObject({
      content: '已生成的策略报告正文', incomplete: true,
    });
    expect(persisted.find((event) => event.type === 'run_finished')).toMatchObject({
      error: '当前模型受策略限制，请切换其他模型继续。',
      failureKind: 'policy_rejection', recoveryAction: 'switch_model',
    });
  });

  it('多轮工具调用后的策略拒绝向子任务结果保留前轮正文与当前 partial', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-policy-multi-turn-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'));
    const adapter = new MultiTurnPolicyFailureAdapter();
    const onResult = vi.fn();
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-policy-multi-turn'),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new PlatformToolRuntime({ providers: [checkToolProvider] }),
    });

    await collect(loop.run({
      message: { channel: 'web', chatId: 'chat-1', content: '执行多轮任务' },
      prompt: '执行多轮任务', instructions: '完成任务。', maxTurns: 2,
      connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
    }, {
      runId: 'run-policy-multi-turn', sessionId: 'session-policy-multi-turn', model: 'gpt-5.6-sol', cwd,
      channelContext: { channel: 'web', outputTransactionMode: 'terminal_buffered', user: { id: 'admin-1', username: 'admin', role: 'admin' } },
      hooks: { onResult },
    }));

    expect(adapter.calls).toBe(2);
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({
      subtype: 'error',
      resultText: '前一轮正文当前轮部分正文',
      failureKind: 'policy_rejection',
      recoveryAction: 'switch_model',
    }));
    const persisted = await eventStore.list('session-policy-multi-turn');
    expect(persisted.some((event) => event.type === 'tool_result' && event.content === '检查完成')).toBe(true);
    expect(persisted.find((event) => event.type === 'assistant_message')).toMatchObject({
      content: '当前轮部分正文', incomplete: true,
    });
  });

  it('terminal_buffered 普通失败不提交候选正文且维持原提示', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-ordinary-error-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'));
    const loop = new RawAgentLoop({
      modelAdapter: new PartialOrdinaryFailureAdapter(),
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-ordinary-error'),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new PlatformToolRuntime(),
    });

    const events = await collect(loop.run({
      message: { channel: 'web', chatId: 'chat-1', content: '继续任务' },
      prompt: '继续任务', instructions: '完成任务。', maxTurns: 1,
      connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
    }, {
      runId: 'run-ordinary-error', sessionId: 'session-ordinary-error', model: 'gpt-5.6-sol', cwd,
      channelContext: { channel: 'web', outputTransactionMode: 'terminal_buffered', user: { id: 'admin-1', username: 'admin', role: 'admin' } },
    }));

    expect(events.at(-1)).toEqual({
      type: 'error',
      error: 'ordinary permanent failure',
      runId: 'run-ordinary-error',
    });
    const persisted = await eventStore.list('session-ordinary-error');
    expect(persisted.some((event) => event.type === 'assistant_message')).toBe(false);
    expect(persisted.find((event) => event.type === 'run_finished')).toMatchObject({ error: 'ordinary permanent failure' });
  });
});
