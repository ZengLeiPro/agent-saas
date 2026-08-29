/**
 * 失败路径的摘要与结构化事实必须进 durable 事件。
 *
 * 背景（2026-08-03 生产摸底）：近 7 天 3,457 次失败调用里只有 7 条带摘要
 * （0.2%）。摘要在 `toolRuntime` 里已按截断前 metadata 造好并随
 * `ToolExecutionError` 抛出，却在 `rawAgentLoop` 主循环的 catch 里被丢弃——
 * 只有 approval-resume 那一条分支接上了，那 7 条就是它。
 * 失败恰是客户最需要事实的时刻，本文件是这条通道唯一的端到端断言。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ToolExecutionError } from '../agent/toolPresentationBuilder.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import {
  runShellToolDescriptor,
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

class ShellThenTextAdapter implements ModelAdapter {
  calls = 0;
  async *stream(_request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    this.calls += 1;
    if (this.calls === 1) {
      yield {
        type: 'completed',
        content: '',
        toolCalls: [{
          id: 'call_shell_fail',
          name: 'Shell',
          arguments: JSON.stringify({ command: 'dws todo create --title 复核合同', description: '创建待办' }),
        }],
      };
      return;
    }
    yield { type: 'text_delta', content: '收尾' };
    yield { type: 'completed', content: '收尾', toolCalls: [] };
  }
}

/** 模拟 provider 在截断前造好摘要与结构化事实后 throw（toolRuntime.ts 的真实形态） */
class FailingToolRuntime implements ToolRuntime {
  constructor(private readonly error: unknown) {}
  list(): ToolDescriptor[] {
    return [runShellToolDescriptor];
  }
  async invoke<TInput>(_call: AuthorizedToolCall<TInput>, _context: ToolCallContext): Promise<ToolResult> {
    throw this.error;
  }
}

function baseContext(cwd: string, suffix: string): RunContext {
  return {
    runId: `run-fail-${suffix}`,
    sessionId: `session-fail-${suffix}`,
    tenantId: DEFAULT_TENANT_ID,
    model: 'gpt-5.5',
    cwd,
    executionTarget: 'server-local',
    // Shell 是 dangerous 档：不开授权模式就会走审批分支（那条分支早已接了摘要），
    // 本文件要断言的正是**主循环 catch**，故显式自动放行。
    approvalPolicy: { autoApproveTools: true },
    channelContext: {
      channel: 'web',
      user: { id: 'admin-1', username: 'admin', role: 'admin' },
    },
    hooks: { onInteraction: async () => ({ allow: true, message: 'ok' }) },
  } as RunContext;
}

async function runFailing(error: unknown, suffix: string): Promise<{
  events: OutboundEvent[];
  toolResultEvent: Record<string, unknown>;
  transcriptLine: Record<string, unknown>;
  cleanup: string;
}> {
  const cwd = await mkdtemp(join(tmpdir(), `tool-failure-${suffix}-`));
  const eventPath = join(cwd, 'session.runtime-events.jsonl');
  const transcriptPath = join(cwd, 'session.jsonl');
  const eventStore = new FileEventStore(eventPath, DEFAULT_TENANT_ID);
  const loop = new RawAgentLoop({
    modelAdapter: new ShellThenTextAdapter(),
    eventStore,
    approvalStore: new EventBackedApprovalStore(eventStore, `session-fail-${suffix}`, DEFAULT_TENANT_ID),
    transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
    toolRuntime: new FailingToolRuntime(error),
  });

  const events = await collect(loop.run(
    {
      message: { channel: 'web', chatId: 'chat-1', content: '建个待办' },
      prompt: '建个待办',
      instructions: '必须调用工具。',
      maxTurns: 4,
      connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
    },
    baseContext(cwd, suffix),
  ));

  const durable = (await readFile(eventPath, 'utf-8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const toolResultEvent = durable.find((event) => event.type === 'tool_result')!;

  const transcript = (await readFile(transcriptPath, 'utf-8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const transcriptLine = transcript.find((line) => {
    const content = (line.message as { content?: unknown[] } | undefined)?.content;
    return Array.isArray(content) && (content[0] as { type?: string })?.type === 'tool_result';
  })!;

  return { events, toolResultEvent, transcriptLine, cleanup: cwd };
}

describe('失败路径的摘要与结构化事实', () => {
  const dirs = new Set<string>();
  afterEach(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
    dirs.clear();
  });

  it('ToolExecutionError 自带的摘要与 metadata 一路落进 durable tool_result 事件', async () => {
    const { toolResultEvent, cleanup } = await runFailing(
      new ToolExecutionError(
        'command failed with exit code 127',
        {
          title: '钉钉 · 待办 · create',
          detail: [{ k: '命令', v: 'dws todo create --title 复核合同' }, { tree: '├', k: '退出码', v: '127' }],
          status: 'warn',
        },
        { exitCode: 127, durationMs: 210, stderrBytes: 58 },
      ),
      'carried',
    );
    dirs.add(cleanup);

    expect(toolResultEvent.isError).toBe(true);
    expect(toolResultEvent.presentation).toMatchObject({ title: '钉钉 · 待办 · create', status: 'warn' });
    expect(toolResultEvent.metadata).toEqual({ exitCode: 127, durationMs: 210, stderrBytes: 58 });
  });

  it('摘要同样落进 transcript 行，前端历史加载能读到（不只是 durable 事件里躺着）', async () => {
    const { transcriptLine, cleanup } = await runFailing(
      new ToolExecutionError('boom', { title: '执行命令', status: 'warn' }, { exitCode: 2 }),
      'transcript',
    );
    dirs.add(cleanup);

    const block = (transcriptLine.message as { content: Array<Record<string, unknown>> }).content[0]!;
    expect(block.is_error).toBe(true);
    expect(block.presentation).toMatchObject({ title: '执行命令' });
    expect(block.metadata).toEqual({ exitCode: 2 });
  });

  it('普通 Error（无 provider 摘要）退回入参侧规则并强制标 warn，metadata 缺省不编造', async () => {
    const { toolResultEvent, cleanup } = await runFailing(new Error('spawn ENOENT'), 'plain');
    dirs.add(cleanup);

    expect(toolResultEvent.presentation).toMatchObject({ title: '钉钉 · 创建待办', status: 'warn' });
    expect(toolResultEvent.metadata).toBeUndefined();
  });

  it('失败不阻断会话收尾——摘要是追加通道，不改变既有控制流', async () => {
    const { events, cleanup } = await runFailing(new Error('spawn ENOENT'), 'flow');
    dirs.add(cleanup);

    expect(events.at(-1)).toEqual({ type: 'done' });
    const streamed = events.find((event) => event.type === 'tool_result');
    expect(streamed).toMatchObject({ toolName: 'Shell', isError: true });
  });
});
