import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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
import type { ModelAdapter, ModelEvent, ModelRequest, RunContext } from '../runtime/types.js';
import type { OutboundEvent } from '../types/index.js';

async function collect(stream: AsyncIterable<OutboundEvent>): Promise<OutboundEvent[]> {
  const events: OutboundEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** 第一轮发一个 Write 工具调用，第二轮（若可达）直接收尾文本。 */
class WriteThenTextAdapter implements ModelAdapter {
  calls = 0;
  async *stream(_request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    this.calls += 1;
    if (this.calls === 1) {
      yield {
        type: 'completed',
        content: '',
        toolCalls: [{
          id: 'call_write_hand',
          name: 'Write',
          arguments: JSON.stringify({ path: 'x.txt', content: 'y' }),
        }],
      };
      return;
    }
    yield { type: 'text_delta', content: '收尾' };
    yield { type: 'completed', content: '收尾', toolCalls: [] };
  }
}

/** 每轮都只发同一个 Write 工具调用 —— 用于逼近 maxTurns 上限。 */
class AlwaysToolCallAdapter implements ModelAdapter {
  async *stream(_request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    yield {
      type: 'completed',
      content: '',
      toolCalls: [{
        id: `call_loop_${Math.random().toString(36).slice(2)}`,
        name: 'Read',
        arguments: JSON.stringify({ path: 'x.txt' }),
      }],
    };
  }
}

/** 恒抛指定 message 的 ToolRuntime（模拟远端 hand 调用失败的外部边界）。 */
class ThrowingToolRuntime implements ToolRuntime {
  constructor(private readonly message: string) {}
  list(): ToolDescriptor[] {
    return [writeFileToolDescriptor];
  }
  async invoke<TInput>(_call: AuthorizedToolCall<TInput>, _context: ToolCallContext): Promise<ToolResult> {
    throw new Error(this.message);
  }
}

function baseContext(cwd: string, overrides: Partial<RunContext> = {}): RunContext {
  return {
    runId: 'run-hand',
    sessionId: 'session-hand',
    model: 'gpt-5.5',
    cwd,
    executionTarget: 'server-remote',
    channelContext: {
      channel: 'web',
      user: { id: 'admin-1', username: 'admin', role: 'admin' },
    },
    hooks: { onInteraction: async () => ({ allow: true, message: 'ok' }) },
    ...overrides,
  } as RunContext;
}

describe('RawAgentLoop server-remote hand_failure 分类', () => {
  const cleanupDirs = new Set<string>();
  afterEach(async () => {
    for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
    cleanupDirs.clear();
  });

  async function runWithFailure(message: string, sessionSuffix: string): Promise<Record<string, unknown>> {
    const cwd = await mkdtemp(join(tmpdir(), `raw-loop-hand-${sessionSuffix}-`));
    cleanupDirs.add(cwd);
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const eventStore = new FileEventStore(eventPath);
    const loop = new RawAgentLoop({
      modelAdapter: new WriteThenTextAdapter(),
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, `session-hand-${sessionSuffix}`),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new ThrowingToolRuntime(message),
    });

    await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '写文件' },
        prompt: '写文件',
        instructions: '必须调用工具。',
        maxTurns: 4,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      baseContext(cwd, {
        runId: `run-hand-${sessionSuffix}`,
        sessionId: `session-hand-${sessionSuffix}`,
      }),
    ));

    const log = await readFile(eventPath, 'utf-8');
    const handFailure = log
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((event) => event.type === 'hand_failure');
    expect(handFailure).toBeTruthy();
    return handFailure!;
  }

  it('server-remote 工具失败时写入 hand_failure，并把错误信息归类为 auth', async () => {
    const failure = await runWithFailure('远端返回 401 unauthorized', 'auth');
    expect(failure).toMatchObject({
      toolName: 'Write',
      classifiedAs: 'auth',
    });
    expect(failure.error).toContain('unauthorized');
  });

  it('timeout 关键词归类为 timeout', async () => {
    const failure = await runWithFailure('request timed out after 30000ms', 'timeout');
    expect(failure.classifiedAs).toBe('timeout');
  });

  it('network/fetch 关键词归类为 network', async () => {
    const failure = await runWithFailure('fetch failed: ECONNREFUSED', 'network');
    expect(failure.classifiedAs).toBe('network');
  });

  it('unhealthy 关键词归类为 unhealthy', async () => {
    const failure = await runWithFailure('hand reported unhealthy status', 'unhealthy');
    expect(failure.classifiedAs).toBe('unhealthy');
  });

  it('无关键词归类为 unknown，且 tool_result 仍标 isError（不阻断会话收尾）', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-hand-unknown-'));
    cleanupDirs.add(cwd);
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const eventStore = new FileEventStore(eventPath);
    const loop = new RawAgentLoop({
      modelAdapter: new WriteThenTextAdapter(),
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-hand-unknown'),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new ThrowingToolRuntime('some opaque backend explosion'),
    });

    const events = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '写文件' },
        prompt: '写文件',
        instructions: '必须调用工具。',
        maxTurns: 4,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      baseContext(cwd, { runId: 'run-hand-unknown', sessionId: 'session-hand-unknown' }),
    ));

    // 会话仍能收尾（工具错误被降级为 isError tool_result，模型下一轮拿到并收尾）
    expect(events.at(-1)).toEqual({ type: 'done' });
    const toolResult = events.find((event) => event.type === 'tool_result');
    expect(toolResult).toMatchObject({ toolName: 'Write', isError: true });

    const log = await readFile(eventPath, 'utf-8');
    const handFailure = log
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((event) => event.type === 'hand_failure');
    expect(handFailure).toMatchObject({ classifiedAs: 'unknown' });
  });

  it('server-local 执行目标失败时不写 hand_failure（该事件仅用于远端 hand 观测）', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-hand-local-'));
    cleanupDirs.add(cwd);
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const eventStore = new FileEventStore(eventPath);
    const loop = new RawAgentLoop({
      modelAdapter: new WriteThenTextAdapter(),
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-hand-local'),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new ThrowingToolRuntime('unauthorized 401'),
    });

    await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '写文件' },
        prompt: '写文件',
        instructions: '必须调用工具。',
        maxTurns: 4,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      baseContext(cwd, {
        runId: 'run-hand-local',
        sessionId: 'session-hand-local',
        executionTarget: 'server-local',
      }),
    ));

    const log = await readFile(eventPath, 'utf-8');
    expect(log).not.toContain('"type":"hand_failure"');
  });
});

describe('RawAgentLoop maxTurns 上限', () => {
  const cleanupDirs = new Set<string>();
  afterEach(async () => {
    for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
    cleanupDirs.clear();
  });

  it('模型每轮都发工具调用、始终不收尾时，达到 maxTurns 抛错并写 run_finished(error)', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-maxturns-'));
    cleanupDirs.add(cwd);
    // 需要一个真实文件让 Read 成功，逼模型进入下一轮（工具本身不报错，纯粹靠轮数耗尽）。
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(cwd, 'x.txt'), 'seed', 'utf-8');
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const eventStore = new FileEventStore(eventPath);
    const { PlatformToolRuntime } = await import('../agent/toolRuntime.js');
    const loop = new RawAgentLoop({
      modelAdapter: new AlwaysToolCallAdapter(),
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-maxturns'),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new PlatformToolRuntime(),
    });

    const events = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '循环' },
        prompt: '循环',
        instructions: '一直调用工具。',
        maxTurns: 2,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'run-maxturns',
        sessionId: 'session-maxturns',
        model: 'gpt-5.5',
        cwd,
        executionTarget: 'server-local',
        channelContext: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin', tenantId: 'pantheon' },
        },
        approvalPolicy: { autoApproveTools: true },
      },
    ));

    const errorEvent = events.at(-1);
    expect(errorEvent?.type).toBe('error');
    expect((errorEvent as { error?: string })?.error).toContain('exceeded maxTurns=2');

    const log = await readFile(eventPath, 'utf-8');
    const runFinished = log
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((event) => event.type === 'run_finished');
    expect(runFinished).toMatchObject({ subtype: 'error' });
    expect((runFinished!.error as string)).toContain('exceeded maxTurns=2');
  });
});
