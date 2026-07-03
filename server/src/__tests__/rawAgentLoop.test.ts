import { existsSync, readFileSync } from 'fs';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PlatformToolRuntime,
  WORKSPACE_HAND_TOOLS,
  writeFileToolDescriptor,
  type AuthorizedToolCall,
  type ToolCallContext,
  type ToolDescriptor,
  type ToolResult,
  type ToolRuntime,
} from '../agent/toolRuntime.js';
import { createBuiltinTools } from '../agent/builtinTools.js';
import { EventBackedApprovalStore } from '../runtime/approvalStore.js';
import { buildContextProjection } from '../runtime/contextProjection.js';
import { FileEventStore } from '../runtime/fileEventStore.js';
import { LegacyTranscriptProjection } from '../runtime/legacyTranscriptProjection.js';
import { RawAgentLoop } from '../runtime/rawAgentLoop.js';
import { InMemoryToolInvocationStore } from '../runtime/toolInvocationStore.js';
import type { LatestResponseSessionState, ResponseSessionStatePatch, RunStore } from '../runtime/runStore.js';
import type { ModelAdapter, ModelEvent, ModelRequest, ModelToolCall, RunContext } from '../runtime/types.js';
import type { OutboundEvent } from '../types/index.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

class FakeToolCallingAdapter implements ModelAdapter {
  calls = 0;
  requests: ModelRequest[] = [];

  async *stream(request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    this.calls += 1;
    this.requests.push(request);
    if (this.calls === 1) {
      yield {
        type: 'completed',
        content: '',
        toolCalls: [{
          id: 'call_write_1',
          name: 'Write',
          arguments: JSON.stringify({ path: 'approved.txt', content: 'RAW_LOOP_OK' }),
        }],
        usage: { inputTokens: 20, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      };
      return;
    }
    yield { type: 'text_delta', content: '完成' };
    yield {
      type: 'completed',
      content: '完成',
      toolCalls: [],
      usage: { inputTokens: 12, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    };
  }
}

class ToolCallOnlyAdapter implements ModelAdapter {
  async *stream(_request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    yield {
      type: 'completed',
      content: '',
      toolCalls: [{
        id: 'call_resume_write',
        name: 'Write',
        arguments: JSON.stringify({ path: 'resumed.txt', content: 'RESUMED_OK' }),
      }],
    };
  }
}

class StaticToolCallsAdapter implements ModelAdapter {
  constructor(private readonly toolCalls: ModelToolCall[]) {}

  async *stream(_request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    yield {
      type: 'completed',
      content: '',
      toolCalls: this.toolCalls,
    };
  }
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
          id: 'call_shell_1',
          name: 'Shell',
          arguments: JSON.stringify({ command: 'pwd', timeoutMs: 1000 }),
        }],
      };
      return;
    }
    yield { type: 'text_delta', content: 'shell done' };
    yield {
      type: 'completed',
      content: 'shell done',
      toolCalls: [],
      usage: { inputTokens: 3, outputTokens: 2 },
    };
  }
}

class TextThenToolThenTextAdapter implements ModelAdapter {
  calls = 0;

  async *stream(_request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    this.calls += 1;
    if (this.calls === 1) {
      yield { type: 'text_delta', content: '先读取文件。' };
      yield {
        type: 'completed',
        content: '先读取文件。',
        toolCalls: [{
          id: 'call_read_live_1',
          name: 'Read',
          arguments: JSON.stringify({ path: 'seed.txt' }),
        }],
      };
      return;
    }
    yield { type: 'text_delta', content: '最终答案。' };
    yield {
      type: 'completed',
      content: '最终答案。',
      toolCalls: [],
      usage: { inputTokens: 3, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    };
  }
}

class StaticContentToolThenTextAdapter implements ModelAdapter {
  calls = 0;

  async *stream(_request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    this.calls += 1;
    if (this.calls === 1) {
      yield {
        type: 'completed',
        content: '我要先读文件。',
        toolCalls: [{
          id: 'call_read_static_1',
          name: 'Read',
          arguments: JSON.stringify({ path: 'seed.txt' }),
        }],
      };
      return;
    }
    yield { type: 'text_delta', content: '读完了。' };
    yield {
      type: 'completed',
      content: '读完了。',
      toolCalls: [],
      usage: { inputTokens: 3, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    };
  }
}

class AskUserOnlyAdapter implements ModelAdapter {
  async *stream(_request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    yield {
      type: 'completed',
      content: '',
      toolCalls: [{
        id: 'call_ask_1',
        name: 'AskUserQuestion',
        arguments: JSON.stringify({
          questions: [{
            question: 'Which branch should I use?',
            header: 'Branch',
            options: [
              { label: 'main', description: 'Use main' },
              { label: 'dev', description: 'Use dev' },
            ],
            multiSelect: false,
          }],
        }),
      }],
    };
  }
}

class AskUserAndReadAdapter implements ModelAdapter {
  async *stream(_request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    yield {
      type: 'completed',
      content: '',
      toolCalls: [
        {
          id: 'call_ask_batch',
          name: 'AskUserQuestion',
          arguments: JSON.stringify({
            questions: [{
              question: 'Which branch should I use?',
              header: 'Branch',
              options: [
                { label: 'main', description: 'Use main' },
                { label: 'dev', description: 'Use dev' },
              ],
              multiSelect: false,
            }],
          }),
        },
        {
          id: 'call_ask_read',
          name: 'Read',
          arguments: JSON.stringify({ path: 'seed.txt' }),
        },
      ],
    };
  }
}

class FinalTextAdapter implements ModelAdapter {
  requests: ModelRequest[] = [];

  async *stream(request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    yield { type: 'text_delta', content: '恢复完成' };
    yield {
      type: 'completed',
      content: '恢复完成',
      toolCalls: [],
      usage: { inputTokens: 3, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    };
  }
}

class EmptyUsageAdapter implements ModelAdapter {
  async *stream(_request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    yield {
      type: 'completed',
      content: '',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 11, outputTokens: 1, cacheReadInputTokens: 5, cacheCreationInputTokens: 0 },
    };
  }
}

class ThinkingTextAdapter implements ModelAdapter {
  async *stream(_request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    yield { type: 'thinking_delta', content: '先判断需求。' };
    yield { type: 'thinking_delta', content: '再给结论。' };
    yield { type: 'text_delta', content: '完成' };
    yield {
      type: 'completed',
      content: '完成',
      toolCalls: [],
      usage: { inputTokens: 4, outputTokens: 3, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    };
  }
}

class FailingAuditToolRuntime implements ToolRuntime {
  list(): ToolDescriptor[] {
    return [writeFileToolDescriptor];
  }

  async invoke<TInput>(_call: AuthorizedToolCall<TInput>, context: ToolCallContext): Promise<ToolResult> {
    context.executionAudit?.record({
      provider: 'server-container',
      operation: 'writeFile',
      image: 'test-container-image',
      containerName: 'test-container-name',
      timeoutMs: 1234,
      stdoutBytes: 0,
      stderrBytes: 16,
      exitCode: 1,
      signal: null,
      status: 'error',
      error: 'test container failure',
    });
    throw new Error('test container failure');
  }
}

async function collect(stream: AsyncIterable<OutboundEvent>): Promise<OutboundEvent[]> {
  const events: OutboundEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('RawAgentLoop', () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    cleanupDirs.clear();
  });

  it('persists approval before executing Write and projects legacy transcript', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-'));
    cleanupDirs.add(cwd);
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const transcriptPath = join(cwd, 'session.jsonl');
    const adapter = new FakeToolCallingAdapter();
    const eventStore = new FileEventStore(eventPath);
    const approvalStore = new EventBackedApprovalStore(eventStore, 'session-1');
    const toolInvocationStore = new InMemoryToolInvocationStore();
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore,
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime(),
      toolInvocationStore,
    });

    const events = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '写文件' },
        prompt: '写文件',
        instructions: '必须调用工具。',
        maxTurns: 4,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'run-1',
        sessionId: 'session-1',
        model: 'doubao-pro',
        cwd,
        tenantId: 'wain-test',
        channelContext: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
        hooks: {
          onInteraction: async (event) => {
            expect(event.type).toBe('permission_request');
            expect(event.interactionId).toBeTruthy();
            expect(event.toolName).toBe('Write');
            expect(event.toolInput).toEqual({ path: 'approved.txt', content: 'RAW_LOOP_OK' });
            expect(existsSync(join(cwd, 'approved.txt'))).toBe(false);
            const pending = await approvalStore.get(event.interactionId);
            expect(pending?.status).toBe('pending');
            return { allow: true, message: 'ok' };
          },
        },
      },
    ));

    expect(readFileSync(join(cwd, 'approved.txt'), 'utf-8')).toBe('RAW_LOOP_OK');
    expect(events.map((event) => event.type)).toContain('tool_result');
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(adapter.calls).toBe(2);
    const invocation = await toolInvocationStore.get('run-1:call_write_1');
    expect(invocation?.status).toBe('completed');
    expect(invocation?.toolName).toBe('Write');
    expect(invocation?.tenantId).toBe('wain-test');
    expect(adapter.requests[1]?.messages.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'call_write_1',
      content: 'wrote approved.txt (11 chars)',
    });

    const eventLog = await readFile(eventPath, 'utf-8');
    expect(eventLog).toContain('"type":"approval_requested"');
    expect(eventLog).toContain('"type":"approval_resolved"');
    expect(eventLog).toContain('"type":"tool_audit"');
    expect(eventLog).toContain('"type":"tool_result"');
    const runtimeEvents = eventLog
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as any);
    const toolCallEvent = runtimeEvents.find((event) => event.type === 'assistant_tool_calls');
    expect(toolCallEvent).toMatchObject({
      model: 'doubao-pro',
      usage: { inputTokens: 20, outputTokens: 5 },
    });
    const runFinished = runtimeEvents.find((event) => event.type === 'run_finished');
    expect(runFinished?.modelUsage?.['doubao-pro']).toMatchObject({
      inputTokens: 32,
      outputTokens: 7,
      apiRequestCount: 2,
    });
    const auditEvent = runtimeEvents.find((event) => event.type === 'tool_audit');
    expect(auditEvent).toMatchObject({
      toolCallId: 'call_write_1',
      toolId: 'Write',
      toolName: 'Write',
      tenantId: 'wain-test',
      risk: 'workspace_write',
      status: 'success',
      executionTarget: 'server-local',
      authorization: {
        source: 'human_approval',
        approved: true,
      },
    });
    expect(auditEvent.approvalId).toBeTruthy();

    expect((await approvalStore.list('session-1')).map((approval) => approval.status)).toEqual(['approved']);

    const transcript = await readFile(transcriptPath, 'utf-8');
    expect(transcript).toContain('"type":"tool_use"');
    expect(transcript).toContain('"tool_result"');
    expect(transcript).toContain('"text":"完成"');
    expect(transcript).toContain('"api_request_count":1');
  });

  it('auto-approves workspace writes for platform-admin runs when tool auto-approval is enabled', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-write-auto-'));
    cleanupDirs.add(cwd);
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const transcriptPath = join(cwd, 'session.jsonl');
    const eventStore = new FileEventStore(eventPath);
    const approvalStore = new EventBackedApprovalStore(eventStore, 'session-write-auto');
    const loop = new RawAgentLoop({
      modelAdapter: new FakeToolCallingAdapter(),
      eventStore,
      approvalStore,
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime(),
    });

    const events = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '写文件' },
        prompt: '写文件',
        instructions: '必须调用 Write。',
        maxTurns: 4,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'run-write-auto',
        sessionId: 'session-write-auto',
        model: 'gpt-5.5',
        cwd,
        channelContext: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID },
        },
        approvalPolicy: { autoApproveTools: true },
      },
    ));

    expect(readFileSync(join(cwd, 'approved.txt'), 'utf-8')).toBe('RAW_LOOP_OK');
    expect(events.map((event) => event.type)).toContain('tool_result');
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect((await approvalStore.list('session-write-auto'))).toEqual([]);

    const eventLog = await readFile(eventPath, 'utf-8');
    expect(eventLog).not.toContain('"type":"approval_requested"');
    const auditEvent = eventLog
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as any)
      .find((event) => event.type === 'tool_audit');
    expect(auditEvent).toMatchObject({
      toolCallId: 'call_write_1',
      toolId: 'Write',
      toolName: 'Write',
      risk: 'workspace_write',
      status: 'success',
      authorization: {
        source: 'policy_auto',
        approved: true,
      },
    });
  });

  it('auto-approves workspace writes for regular tenant users when tool auto-approval is enabled', async () => {
    // 授权模式对所有已认证用户生效（2026-07-02 起）：普通用户开启后
    // Write/Edit 免人工审批；Shell 的宿主隔离兜底另行覆盖（toolRuntime.test.ts）。
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-write-auto-user-'));
    cleanupDirs.add(cwd);
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const transcriptPath = join(cwd, 'session.jsonl');
    const eventStore = new FileEventStore(eventPath);
    const approvalStore = new EventBackedApprovalStore(eventStore, 'session-write-auto-user');
    const loop = new RawAgentLoop({
      modelAdapter: new FakeToolCallingAdapter(),
      eventStore,
      approvalStore,
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime(),
    });

    const events = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '写文件' },
        prompt: '写文件',
        instructions: '必须调用 Write。',
        maxTurns: 4,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'run-write-auto-user',
        sessionId: 'session-write-auto-user',
        model: 'gpt-5.5',
        cwd,
        channelContext: {
          channel: 'web',
          user: { id: 'user-1', username: 'wain_user', role: 'user', tenantId: 'wain-test' },
        },
        approvalPolicy: { autoApproveTools: true },
      },
    ));

    expect(readFileSync(join(cwd, 'approved.txt'), 'utf-8')).toBe('RAW_LOOP_OK');
    expect(events.map((event) => event.type)).toContain('tool_result');
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect((await approvalStore.list('session-write-auto-user'))).toEqual([]);

    const eventLog = await readFile(eventPath, 'utf-8');
    expect(eventLog).not.toContain('"type":"approval_requested"');
    const auditEvent = eventLog
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as any)
      .find((event) => event.type === 'tool_audit');
    expect(auditEvent).toMatchObject({
      toolCallId: 'call_write_1',
      toolId: 'Write',
      toolName: 'Write',
      risk: 'workspace_write',
      status: 'success',
      authorization: {
        source: 'policy_auto',
        approved: true,
      },
    });
  });

  it('keeps the legacy Shell auto-approval field compatible for platform-admin runs', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-shell-auto-'));
    cleanupDirs.add(cwd);
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const transcriptPath = join(cwd, 'session.jsonl');
    const eventStore = new FileEventStore(eventPath);
    const approvalStore = new EventBackedApprovalStore(eventStore, 'session-shell-auto');
    const invoke = vi.fn(async () => ({ status: 'success' as const, content: 'shell ok' }));
    const loop = new RawAgentLoop({
      modelAdapter: new ShellThenTextAdapter(),
      eventStore,
      approvalStore,
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime({
        executionTransport: {
          invoke,
          listInternalTools: () => WORKSPACE_HAND_TOOLS,
        },
      }),
    });

    const events = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '跑 shell' },
        prompt: '跑 shell',
        instructions: '必须调用 Shell。',
        maxTurns: 4,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'run-shell-auto',
        sessionId: 'session-shell-auto',
        model: 'gpt-5.5',
        cwd,
        channelContext: {
          channel: 'web',
          // 授权模式对所有已认证用户生效；此处沿用平台 admin 验证 legacy 字段兼容。
          // 非平台用户的 Shell 仍受隔离 hand/container 兜底约束（toolRuntime.test.ts）。
          user: { id: 'admin-1', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID },
        },
        approvalPolicy: { autoApproveRunShell: true },
      },
    ));

    expect(events.map((event) => event.type)).toContain('tool_result');
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(invoke).toHaveBeenCalledOnce();
    expect((await approvalStore.list('session-shell-auto'))).toEqual([]);

    const eventLog = await readFile(eventPath, 'utf-8');
    expect(eventLog).not.toContain('"type":"approval_requested"');
    const auditEvent = eventLog
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as any)
      .find((event) => event.type === 'tool_audit');
    expect(auditEvent).toMatchObject({
      toolCallId: 'call_shell_1',
      toolId: 'Shell',
      toolName: 'Shell',
      risk: 'dangerous',
      status: 'success',
      authorization: {
        source: 'policy_auto',
        approved: true,
      },
    });
  });

  it('closes streamed text before tool calls and opens a fresh block for the final answer', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-text-tool-text-'));
    cleanupDirs.add(cwd);
    await writeFile(join(cwd, 'seed.txt'), 'seed content', 'utf-8');
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const transcriptPath = join(cwd, 'session.jsonl');
    const eventStore = new FileEventStore(eventPath);
    const loop = new RawAgentLoop({
      modelAdapter: new TextThenToolThenTextAdapter(),
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-text-tool-text'),
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime(),
    });

    const events = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '读文件后回答' },
        prompt: '读文件后回答',
        instructions: '先读文件，再回答。',
        maxTurns: 4,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'run-text-tool-text',
        sessionId: 'session-text-tool-text',
        model: 'gpt-5.5',
        cwd,
        channelContext: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
      },
    ));

    expect(events.map((event) => event.type)).toEqual([
      'text_start',
      'text_delta',
      'text_end',
      'tool_start',
      'tool_input_delta',
      'tool_end',
      'tool_result',
      'text_start',
      'text_delta',
      'text_end',
      'done',
    ]);

    const runtimeEvents = await eventStore.list('session-text-tool-text');
    const toolCallEvent = runtimeEvents.find((event) => event.type === 'assistant_tool_calls');
    expect(toolCallEvent).toMatchObject({
      content: '先读取文件。',
      streamed: true,
    });
    // 2026-07-03 起逐 token delta 不再落库：EventStore 里不应再出现 assistant_stream_event，
    // live 流式只走 yield 直推（上方 events 断言已覆盖），持久化内容由聚合行承载。
    const streamEvents = runtimeEvents.filter((event) => event.type === 'assistant_stream_event');
    expect(streamEvents).toEqual([]);
  });

  it('streams assistant_tool_calls content when the model only returns it in the completed event', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-static-tool-content-'));
    cleanupDirs.add(cwd);
    await writeFile(join(cwd, 'seed.txt'), 'seed content', 'utf-8');
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const transcriptPath = join(cwd, 'session.jsonl');
    const eventStore = new FileEventStore(eventPath);
    const loop = new RawAgentLoop({
      modelAdapter: new StaticContentToolThenTextAdapter(),
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-static-tool-content'),
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime(),
    });

    const events = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '读文件后回答' },
        prompt: '读文件后回答',
        instructions: '先读文件，再回答。',
        maxTurns: 4,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'run-static-tool-content',
        sessionId: 'session-static-tool-content',
        model: 'gpt-5.5',
        cwd,
        channelContext: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
      },
    ));

    expect(events.slice(0, 4).map((event) => event.type)).toEqual([
      'text_start',
      'text_delta',
      'text_end',
      'tool_start',
    ]);
    expect(events).toContainEqual({ type: 'text_delta', content: '我要先读文件。' });
    expect(events).toContainEqual({ type: 'text_delta', content: '读完了。' });

    const runtimeEvents = await eventStore.list('session-static-tool-content');
    const toolCallEvent = runtimeEvents.find((event) => event.type === 'assistant_tool_calls');
    expect(toolCallEvent).toMatchObject({
      content: '我要先读文件。',
      streamed: true,
    });
  });

  it('records partial usage on model/loop error', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-error-usage-'));
    cleanupDirs.add(cwd);
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const transcriptPath = join(cwd, 'session.jsonl');
    const eventStore = new FileEventStore(eventPath);
    const onResult = vi.fn();
    const loop = new RawAgentLoop({
      modelAdapter: new EmptyUsageAdapter(),
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-error-usage'),
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime(),
    });

    const events = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '空回复' },
        prompt: '空回复',
        instructions: '返回空内容。',
        maxTurns: 1,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'run-error-usage',
        sessionId: 'session-error-usage',
        model: 'gpt-5.5',
        cwd,
        channelContext: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
        hooks: { onResult },
      },
    ));

    expect(events.at(-1)?.type).toBe('error');
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({
      subtype: 'error',
      modelUsage: {
        'gpt-5.5': expect.objectContaining({
          inputTokens: 11,
          outputTokens: 1,
          cacheReadInputTokens: 5,
          apiRequestCount: 1,
        }),
      },
    }));
    const runtimeEvents = (await readFile(eventPath, 'utf-8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as any);
    const runFinished = runtimeEvents.find((event) => event.type === 'run_finished');
    expect(runFinished).toMatchObject({
      subtype: 'error',
      modelUsage: {
        'gpt-5.5': {
          inputTokens: 11,
          outputTokens: 1,
          cacheReadInputTokens: 5,
          cacheCreationInputTokens: 0,
          apiRequestCount: 1,
        },
      },
    });
  });

  it('can send a hidden continuation prompt without recording a user_message', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-hidden-continue-'));
    cleanupDirs.add(cwd);
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const transcriptPath = join(cwd, 'session.jsonl');
    const adapter = new FinalTextAdapter();
    const eventStore = new FileEventStore(eventPath);
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-hidden-continue'),
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime(),
    });

    const events = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: 'continue hidden' },
        prompt: 'continue hidden',
        recordUserMessage: false,
        instructions: 'Continue only.',
        maxTurns: 1,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'run-hidden-continue',
        sessionId: 'session-hidden-continue',
        model: 'gpt-5.5',
        cwd,
        channelContext: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
      },
    ));

    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(adapter.requests[0]?.messages.at(-1)).toEqual({ role: 'user', content: 'continue hidden' });
    const runtimeEvents = (await readFile(eventPath, 'utf-8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as any);
    expect(runtimeEvents.map((event) => event.type)).not.toContain('user_message');
    const transcript = await readFile(transcriptPath, 'utf-8');
    expect(transcript).not.toContain('"role":"user"');
    expect(transcript).not.toContain('continue hidden');
  });

  it('streams and persists model thinking into runtime events and legacy transcript', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-thinking-'));
    cleanupDirs.add(cwd);
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const transcriptPath = join(cwd, 'session.jsonl');
    const eventStore = new FileEventStore(eventPath);
    const loop = new RawAgentLoop({
      modelAdapter: new ThinkingTextAdapter(),
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-thinking-1'),
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime(),
    });

    const events = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '执行' },
        prompt: '执行',
        instructions: '正常回答。',
        maxTurns: 2,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'run-thinking-1',
        sessionId: 'session-thinking-1',
        model: 'glm-5.2',
        cwd,
        channelContext: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
      },
    ));

    expect(events.map((event) => event.type)).toEqual([
      'thinking_start',
      'thinking_delta',
      'thinking_delta',
      'thinking_end',
      'text_start',
      'text_delta',
      'text_end',
      'done',
    ]);

    const runtimeEvents = (await eventStore.list('session-thinking-1'));
    const thinkingEvent = runtimeEvents.find((event) => event.type === 'assistant_thinking');
    expect(thinkingEvent).toMatchObject({
      content: '先判断需求。再给结论。',
      streamed: true,
    });
    // 2026-07-03 起 thinking 耗时由聚合行 durationMs 携带（delta 已停写）
    expect(thinkingEvent && 'durationMs' in thinkingEvent ? thinkingEvent.durationMs : undefined)
      .toBeGreaterThanOrEqual(0);
    expect(runtimeEvents.filter((event) => event.type === 'assistant_stream_event')).toEqual([]);

    const transcript = await readFile(transcriptPath, 'utf-8');
    expect(transcript).toContain('"type":"thinking"');
    expect(transcript).toContain('"thinking":"先判断需求。再给结论。"');
    expect(transcript).toContain('"text":"完成"');
  });

  it('resumes a pending approval from approval and runtime event logs after runtime rebuild', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-resume-'));
    cleanupDirs.add(cwd);
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const transcriptPath = join(cwd, 'session.jsonl');
    const firstEventStore = new FileEventStore(eventPath);
    const approvalStore = new EventBackedApprovalStore(firstEventStore, 'session-resume-1');
    const firstLoop = new RawAgentLoop({
      modelAdapter: new ToolCallOnlyAdapter(),
      eventStore: firstEventStore,
      approvalStore,
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime(),
    });

    let interactionId = '';
    let capturedInteraction: unknown;
    const approvalRequested = new Promise<void>((resolve) => {
      const iterator = firstLoop.run(
        {
          message: { channel: 'web', chatId: 'chat-1', content: '写文件' },
          prompt: '写文件',
          instructions: '必须调用工具。',
          maxTurns: 4,
          connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
        },
        {
          runId: 'run-resume-1',
          sessionId: 'session-resume-1',
          model: 'gpt-5.5',
          cwd,
          channelContext: {
            channel: 'web',
            user: { id: 'admin-1', username: 'admin', role: 'admin' },
          },
          hooks: {
            onInteraction: async (event) => {
              interactionId = event.interactionId;
              capturedInteraction = event;
              resolve();
              return new Promise(() => {});
            },
          },
        },
      )[Symbol.asyncIterator]();
      void iterator.next();
    });

    await approvalRequested;
    expect(capturedInteraction).toMatchObject({
      toolName: 'Write',
      toolId: 'Write',
      displayName: 'Write File',
    });
    expect(existsSync(join(cwd, 'resumed.txt'))).toBe(false);
    expect((await approvalStore.get(interactionId))?.status).toBe('pending');

    const finalAdapter = new FinalTextAdapter();
    const rebuiltEventStore = new FileEventStore(eventPath);
    const rebuiltLoop = new RawAgentLoop({
      modelAdapter: finalAdapter,
      eventStore: rebuiltEventStore,
      approvalStore: new EventBackedApprovalStore(rebuiltEventStore, 'session-resume-1'),
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime(),
    });

    const events = await collect(rebuiltLoop.resumeApproval(
      {
        approvalId: interactionId,
        response: { allow: true, message: 'approve after restart' },
        instructions: '必须调用工具。',
        maxTurns: 4,
      },
      {
        runId: 'run-after-rebuild',
        sessionId: 'session-resume-1',
        model: 'gpt-5.5',
        cwd,
        channelContext: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
      },
    ));

    expect(readFileSync(join(cwd, 'resumed.txt'), 'utf-8')).toBe('RESUMED_OK');
    expect(events.map((event) => event.type)).toContain('tool_result');
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(finalAdapter.requests[0]?.messages.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'call_resume_write',
      content: 'wrote resumed.txt (10 chars)',
    });

    expect((await new EventBackedApprovalStore(rebuiltEventStore, 'session-resume-1').get(interactionId))?.status)
      .toBe('approved');

    const eventLog = await readFile(eventPath, 'utf-8');
    expect(eventLog).toContain('"type":"approval_requested"');
    expect(eventLog).toContain('"type":"approval_resolved"');
    expect(eventLog).toContain('"type":"tool_result"');
  });

  it('drains remaining sibling tool calls after resuming an approval', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-resume-batch-'));
    cleanupDirs.add(cwd);
    await writeFile(join(cwd, 'seed.txt'), 'SEED_OK', 'utf-8');
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const transcriptPath = join(cwd, 'session.jsonl');
    const firstEventStore = new FileEventStore(eventPath);
    const approvalStore = new EventBackedApprovalStore(firstEventStore, 'session-resume-batch-1');
    const firstLoop = new RawAgentLoop({
      modelAdapter: new StaticToolCallsAdapter([
        {
          id: 'call_batch_write',
          name: 'Write',
          arguments: JSON.stringify({ path: 'approved.txt', content: 'APPROVED_OK' }),
        },
        {
          id: 'call_batch_read',
          name: 'Read',
          arguments: JSON.stringify({ path: 'seed.txt' }),
        },
      ]),
      eventStore: firstEventStore,
      approvalStore,
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime(),
    });

    let approvalId = '';
    const approvalRequested = new Promise<void>((resolve) => {
      const iterator = firstLoop.run(
        {
          message: { channel: 'web', chatId: 'chat-1', content: '写后读' },
          prompt: '写后读',
          instructions: '必须调用工具。',
          maxTurns: 4,
          connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
        },
        {
          runId: 'run-resume-batch-1',
          sessionId: 'session-resume-batch-1',
          model: 'gpt-5.5',
          cwd,
          channelContext: {
            channel: 'web',
            user: { id: 'admin-1', username: 'admin', role: 'admin' },
          },
          hooks: {
            onInteraction: async (event) => {
              approvalId = event.interactionId;
              resolve();
              return new Promise(() => {});
            },
          },
        },
      )[Symbol.asyncIterator]();
      void iterator.next();
    });

    await approvalRequested;
    expect(existsSync(join(cwd, 'approved.txt'))).toBe(false);

    const finalAdapter = new FinalTextAdapter();
    const rebuiltEventStore = new FileEventStore(eventPath);
    const rebuiltLoop = new RawAgentLoop({
      modelAdapter: finalAdapter,
      eventStore: rebuiltEventStore,
      approvalStore: new EventBackedApprovalStore(rebuiltEventStore, 'session-resume-batch-1'),
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime(),
    });

    const events = await collect(rebuiltLoop.resumeApproval(
      {
        approvalId,
        response: { allow: true, message: 'ok' },
        instructions: '继续。',
        maxTurns: 4,
      },
      {
        runId: 'run-resume-batch-1',
        sessionId: 'session-resume-batch-1',
        model: 'gpt-5.5',
        cwd,
        channelContext: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
      },
    ));

    expect(readFileSync(join(cwd, 'approved.txt'), 'utf-8')).toBe('APPROVED_OK');
    expect(events.map((event) => event.type)).toContain('done');
    const tail = finalAdapter.requests[0]?.messages.slice(-2);
    expect(tail?.map((message) => message.role)).toEqual(['tool', 'tool']);
    expect(tail?.[0]).toMatchObject({ tool_call_id: 'call_batch_write' });
    expect(tail?.[1]).toMatchObject({ tool_call_id: 'call_batch_read' });
    expect((tail?.[1] as { content: string } | undefined)?.content).toContain('SEED_OK');
  });

  it('pauses on the next sibling approval and resumes the same batch after it is approved', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-resume-two-approvals-'));
    cleanupDirs.add(cwd);
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const transcriptPath = join(cwd, 'session.jsonl');
    const firstEventStore = new FileEventStore(eventPath);
    const approvalStore = new EventBackedApprovalStore(firstEventStore, 'session-two-approvals-1');
    const firstLoop = new RawAgentLoop({
      modelAdapter: new StaticToolCallsAdapter([
        {
          id: 'call_write_a',
          name: 'Write',
          arguments: JSON.stringify({ path: 'a.txt', content: 'A' }),
        },
        {
          id: 'call_write_b',
          name: 'Write',
          arguments: JSON.stringify({ path: 'b.txt', content: 'B' }),
        },
      ]),
      eventStore: firstEventStore,
      approvalStore,
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime(),
    });

    await collect(firstLoop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '写两个文件' },
        prompt: '写两个文件',
        instructions: '必须调用工具。',
        maxTurns: 4,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'run-two-approvals-1',
        sessionId: 'session-two-approvals-1',
        model: 'gpt-5.5',
        cwd,
        channelContext: {
          channel: 'web',
          sessionOwner: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
      },
    ));

    const firstApproval = (await approvalStore.list('session-two-approvals-1'))[0]!;
    expect(firstApproval).toMatchObject({ status: 'pending', toolCallId: 'call_write_a' });

    const finalAdapter = new FinalTextAdapter();
    const secondEventStore = new FileEventStore(eventPath);
    const secondApprovalStore = new EventBackedApprovalStore(secondEventStore, 'session-two-approvals-1');
    const secondLoop = new RawAgentLoop({
      modelAdapter: finalAdapter,
      eventStore: secondEventStore,
      approvalStore: secondApprovalStore,
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime(),
    });

    const firstResumeEvents = await collect(secondLoop.resumeApproval(
      {
        approvalId: firstApproval.id,
        response: { allow: true, message: 'ok a' },
        instructions: '继续。',
        maxTurns: 4,
      },
      {
        runId: 'run-two-approvals-1',
        sessionId: 'session-two-approvals-1',
        model: 'gpt-5.5',
        cwd,
        channelContext: {
          channel: 'web',
          sessionOwner: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
      },
    ));

    expect(firstResumeEvents.map((event) => event.type)).not.toContain('done');
    expect(finalAdapter.requests).toHaveLength(0);
    expect(readFileSync(join(cwd, 'a.txt'), 'utf-8')).toBe('A');
    expect(existsSync(join(cwd, 'b.txt'))).toBe(false);
    const approvalsAfterFirstResume = await secondApprovalStore.list('session-two-approvals-1');
    expect(approvalsAfterFirstResume.map((approval) => [approval.toolCallId, approval.status])).toEqual([
      ['call_write_a', 'approved'],
      ['call_write_b', 'pending'],
    ]);

    const secondApproval = approvalsAfterFirstResume.find((approval) => approval.toolCallId === 'call_write_b')!;
    const secondResumeEvents = await collect(secondLoop.resumeApproval(
      {
        approvalId: secondApproval.id,
        response: { allow: true, message: 'ok b' },
        instructions: '继续。',
        maxTurns: 4,
      },
      {
        runId: 'run-two-approvals-1',
        sessionId: 'session-two-approvals-1',
        model: 'gpt-5.5',
        cwd,
        channelContext: {
          channel: 'web',
          sessionOwner: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
      },
    ));

    expect(secondResumeEvents.map((event) => event.type)).toContain('done');
    expect(readFileSync(join(cwd, 'b.txt'), 'utf-8')).toBe('B');
    const tail = finalAdapter.requests[0]?.messages.slice(-2);
    expect(tail?.map((message) => (message as { tool_call_id?: string }).tool_call_id)).toEqual([
      'call_write_a',
      'call_write_b',
    ]);
  });

  it('keeps approval pending instead of returning a tool error when no interaction hook is available', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-no-hook-'));
    cleanupDirs.add(cwd);
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const transcriptPath = join(cwd, 'session.jsonl');
    const eventStore = new FileEventStore(eventPath);
    const approvalStore = new EventBackedApprovalStore(eventStore, 'session-no-hook');
    const loop = new RawAgentLoop({
      modelAdapter: new ToolCallOnlyAdapter(),
      eventStore,
      approvalStore,
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime(),
    });

    const events = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '写文件' },
        prompt: '写文件',
        instructions: '必须调用工具。',
        maxTurns: 4,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'run-no-hook',
        sessionId: 'session-no-hook',
        model: 'gpt-5.5',
        cwd,
        channelContext: {
          channel: 'web',
          sessionOwner: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
      },
    ));

    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events.some((event) => event.type === 'tool_result')).toBe(false);

    const approvals = await approvalStore.list('session-no-hook');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      status: 'pending',
      toolName: 'Write',
      toolCallId: 'call_resume_write',
    });

    const runtimeEvents = await eventStore.list('session-no-hook');
    expect(runtimeEvents.map((event) => event.type)).toContain('approval_requested');
    expect(runtimeEvents.map((event) => event.type)).not.toContain('approval_resolved');
    expect(runtimeEvents.map((event) => event.type)).not.toContain('tool_result');
    expect(runtimeEvents.map((event) => event.type)).not.toContain('run_finished');
  });

  it('resumes a pending AskUserQuestion from durable interaction events after runtime rebuild', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-ask-resume-'));
    cleanupDirs.add(cwd);
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const transcriptPath = join(cwd, 'session.jsonl');
    const firstEventStore = new FileEventStore(eventPath);
    const toolInvocationStore = new InMemoryToolInvocationStore();
    const firstLoop = new RawAgentLoop({
      modelAdapter: new AskUserOnlyAdapter(),
      eventStore: firstEventStore,
      approvalStore: new EventBackedApprovalStore(firstEventStore, 'session-ask-resume-1'),
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime({ providers: [createBuiltinTools()] }),
      toolInvocationStore,
    });

    let interactionId = '';
    const interactionRequested = new Promise<void>((resolve) => {
      const iterator = firstLoop.run(
        {
          message: { channel: 'web', chatId: 'chat-1', content: '需要问用户' },
          prompt: '需要问用户',
          instructions: '必须调用 AskUserQuestion。',
          maxTurns: 4,
          connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
        },
        {
          runId: 'run-ask-resume-1',
          sessionId: 'session-ask-resume-1',
          model: 'gpt-5.5',
          cwd,
          channelContext: {
            channel: 'web',
            user: { id: 'admin-1', username: 'admin', role: 'admin' },
          },
          hooks: {
            onInteraction: async (event) => {
              interactionId = event.interactionId;
              expect(event).toMatchObject({
                type: 'ask_user',
                runId: 'run-ask-resume-1',
                sessionId: 'session-ask-resume-1',
                toolCallId: 'call_ask_1',
                invocationId: 'run-ask-resume-1:call_ask_1',
                toolName: 'AskUserQuestion',
              });
              await firstEventStore.append({
                type: 'interaction_requested',
                sessionId: 'session-ask-resume-1',
                runId: event.runId,
                toolCallId: event.toolCallId,
                invocationId: event.invocationId,
                interactionId,
                interactionType: 'ask_user',
                userId: 'admin-1',
                toolId: event.toolId,
                toolName: event.toolName,
                displayName: event.displayName,
                questions: event.questions,
              });
              resolve();
              return new Promise(() => {});
            },
          },
        },
      )[Symbol.asyncIterator]();
      void iterator.next();
    });

    await interactionRequested;
    expect((await toolInvocationStore.get('run-ask-resume-1:call_ask_1'))?.status).toBe('running');
    await firstEventStore.append({
      type: 'interaction_resolved',
      sessionId: 'session-ask-resume-1',
      runId: 'run-ask-resume-1',
      toolCallId: 'call_ask_1',
      invocationId: 'run-ask-resume-1:call_ask_1',
      interactionId,
      interactionType: 'ask_user',
      userId: 'admin-1',
      response: { answers: { branch: 'main' }, message: 'Use main' },
    });

    const finalAdapter = new FinalTextAdapter();
    const rebuiltEventStore = new FileEventStore(eventPath);
    const rebuiltLoop = new RawAgentLoop({
      modelAdapter: finalAdapter,
      eventStore: rebuiltEventStore,
      approvalStore: new EventBackedApprovalStore(rebuiltEventStore, 'session-ask-resume-1'),
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime({ providers: [createBuiltinTools()] }),
      toolInvocationStore,
    });

    const events = await collect(rebuiltLoop.resumeInteraction(
      {
        interactionId,
        response: { answers: { branch: 'main' }, message: 'Use main' },
        instructions: '继续。',
        maxTurns: 4,
      },
      {
        runId: 'run-ask-resume-1',
        sessionId: 'session-ask-resume-1',
        model: 'gpt-5.5',
        cwd,
        channelContext: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
      },
    ));

    expect(events.map((event) => event.type)).toContain('tool_result');
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect((await toolInvocationStore.get('run-ask-resume-1:call_ask_1'))?.status).toBe('completed');
    const toolMessage = finalAdapter.requests[0]?.messages.at(-1);
    expect(toolMessage).toMatchObject({ role: 'tool', tool_call_id: 'call_ask_1' });
    expect(JSON.parse((toolMessage as { content: string }).content)).toMatchObject({
      answers: { branch: 'main' },
      message: 'Use main',
    });

    const eventLog = await readFile(eventPath, 'utf-8');
    expect(eventLog).toContain('"type":"interaction_requested"');
    expect(eventLog).toContain('"type":"interaction_resolved"');
    expect(eventLog).toContain('"type":"tool_invocation_completed"');
    expect(eventLog).toContain('"type":"tool_result"');
  });

  it('parks AskUserQuestion as a durable pending interaction when no hook is registered', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-ask-no-hook-'));
    cleanupDirs.add(cwd);
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const transcriptPath = join(cwd, 'session.jsonl');
    const eventStore = new FileEventStore(eventPath);
    const toolInvocationStore = new InMemoryToolInvocationStore();
    const loop = new RawAgentLoop({
      modelAdapter: new AskUserOnlyAdapter(),
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-ask-no-hook-1'),
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime({ providers: [createBuiltinTools()] }),
      toolInvocationStore,
    });

    const events = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '需要问用户' },
        prompt: '需要问用户',
        instructions: '必须调用 AskUserQuestion。',
        maxTurns: 4,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'run-ask-no-hook-1',
        sessionId: 'session-ask-no-hook-1',
        model: 'gpt-5.5',
        cwd,
        channelContext: {
          channel: 'web',
          sessionOwner: { id: 'user-1', username: 'alice', role: 'user' },
        },
      },
    ));

    const askEvent = events.find((event) => event.type === 'ask_user');
    expect(askEvent).toMatchObject({
      type: 'ask_user',
      toolName: 'AskUserQuestion',
      questions: [{
        question: 'Which branch should I use?',
        header: 'Branch',
      }],
    });
    expect(events.map((event) => event.type)).not.toContain('error');
    expect(events.map((event) => event.type)).not.toContain('done');
    expect((await toolInvocationStore.get('run-ask-no-hook-1:call_ask_1'))?.status).toBe('running');

    const eventLog = await readFile(eventPath, 'utf-8');
    expect(eventLog).toContain('"type":"interaction_requested"');
    expect(eventLog).toContain('"interactionType":"ask_user"');
    expect(eventLog).not.toContain('HITL hook not registered');
    expect(eventLog).not.toContain('"type":"tool_result"');
    expect(eventLog).not.toContain('"type":"run_finished"');
  });

  it('drains remaining sibling tool calls after resuming AskUserQuestion', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-ask-batch-'));
    cleanupDirs.add(cwd);
    await writeFile(join(cwd, 'seed.txt'), 'SEED_OK', 'utf-8');
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const transcriptPath = join(cwd, 'session.jsonl');
    const firstEventStore = new FileEventStore(eventPath);
    const toolInvocationStore = new InMemoryToolInvocationStore();
    const firstLoop = new RawAgentLoop({
      modelAdapter: new AskUserAndReadAdapter(),
      eventStore: firstEventStore,
      approvalStore: new EventBackedApprovalStore(firstEventStore, 'session-ask-batch-1'),
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime({ providers: [createBuiltinTools()] }),
      toolInvocationStore,
    });

    let interactionId = '';
    const interactionRequested = new Promise<void>((resolve) => {
      const iterator = firstLoop.run(
        {
          message: { channel: 'web', chatId: 'chat-1', content: '先问再读' },
          prompt: '先问再读',
          instructions: '必须调用 AskUserQuestion 和 Read。',
          maxTurns: 4,
          connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
        },
        {
          runId: 'run-ask-batch-1',
          sessionId: 'session-ask-batch-1',
          model: 'gpt-5.5',
          cwd,
          channelContext: {
            channel: 'web',
            user: { id: 'admin-1', username: 'admin', role: 'admin' },
          },
          hooks: {
            onInteraction: async (event) => {
              interactionId = event.interactionId;
              expect(event).toMatchObject({
                type: 'ask_user',
                runId: 'run-ask-batch-1',
                sessionId: 'session-ask-batch-1',
                toolCallId: 'call_ask_batch',
                invocationId: 'run-ask-batch-1:call_ask_batch',
                toolName: 'AskUserQuestion',
              });
              await firstEventStore.append({
                type: 'interaction_requested',
                sessionId: 'session-ask-batch-1',
                runId: event.runId,
                toolCallId: event.toolCallId,
                invocationId: event.invocationId,
                interactionId,
                interactionType: 'ask_user',
                userId: 'admin-1',
                toolId: event.toolId,
                toolName: event.toolName,
                displayName: event.displayName,
                questions: event.questions,
              });
              resolve();
              return new Promise(() => {});
            },
          },
        },
      )[Symbol.asyncIterator]();
      void iterator.next();
    });

    await interactionRequested;
    expect((await toolInvocationStore.get('run-ask-batch-1:call_ask_batch'))?.status).toBe('running');
    await firstEventStore.append({
      type: 'interaction_resolved',
      sessionId: 'session-ask-batch-1',
      runId: 'run-ask-batch-1',
      toolCallId: 'call_ask_batch',
      invocationId: 'run-ask-batch-1:call_ask_batch',
      interactionId,
      interactionType: 'ask_user',
      userId: 'admin-1',
      response: { answers: { branch: 'main' }, message: 'Use main' },
    });

    const finalAdapter = new FinalTextAdapter();
    const rebuiltEventStore = new FileEventStore(eventPath);
    const rebuiltLoop = new RawAgentLoop({
      modelAdapter: finalAdapter,
      eventStore: rebuiltEventStore,
      approvalStore: new EventBackedApprovalStore(rebuiltEventStore, 'session-ask-batch-1'),
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime({ providers: [createBuiltinTools()] }),
      toolInvocationStore,
    });

    const events = await collect(rebuiltLoop.resumeInteraction(
      {
        interactionId,
        response: { answers: { branch: 'main' }, message: 'Use main' },
        instructions: '继续。',
        maxTurns: 4,
      },
      {
        runId: 'run-ask-batch-1',
        sessionId: 'session-ask-batch-1',
        model: 'gpt-5.5',
        cwd,
        channelContext: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
      },
    ));

    expect(events.map((event) => event.type)).toContain('done');
    expect((await toolInvocationStore.get('run-ask-batch-1:call_ask_batch'))?.status).toBe('completed');
    const tail = finalAdapter.requests[0]?.messages.slice(-2);
    expect(tail?.map((message) => (message as { tool_call_id?: string }).tool_call_id)).toEqual([
      'call_ask_batch',
      'call_ask_read',
    ]);
    expect(JSON.parse((tail?.[0] as { content: string } | undefined)?.content ?? '{}')).toMatchObject({
      answers: { branch: 'main' },
      message: 'Use main',
    });
    expect((tail?.[1] as { content: string } | undefined)?.content).toContain('SEED_OK');
  });

  it('persists execution invocation details in tool_audit when a tool fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-audit-error-'));
    cleanupDirs.add(cwd);
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const transcriptPath = join(cwd, 'session.jsonl');
    const adapter = new FakeToolCallingAdapter();
    const eventStore = new FileEventStore(eventPath);
    const toolInvocationStore = new InMemoryToolInvocationStore();
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-audit-error'),
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new FailingAuditToolRuntime(),
    });

    const events = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '写文件' },
        prompt: '写文件',
        instructions: '必须调用工具。',
        maxTurns: 4,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'run-audit-error',
        sessionId: 'session-audit-error',
        model: 'gpt-5.5',
        cwd,
        executionTarget: 'server-container',
        channelContext: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
        hooks: {
          onInteraction: async () => ({ allow: true, message: 'ok' }),
        },
      },
    ));

    expect(events.map((event) => event.type)).toContain('tool_result');
    const eventLog = await readFile(eventPath, 'utf-8');
    const auditEvent = eventLog
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as any)
      .find((event) => event.type === 'tool_audit');
    expect(auditEvent).toMatchObject({
      toolName: 'Write',
      status: 'error',
      executionTarget: 'server-container',
      executionInvocations: [{
        provider: 'server-container',
        operation: 'writeFile',
        image: 'test-container-image',
        containerName: 'test-container-name',
        timeoutMs: 1234,
        stderrBytes: 16,
        exitCode: 1,
        signal: null,
        status: 'error',
        error: 'test container failure',
      }],
    });
  });

  it('blocks a new run when prior event log has an unclosed pending tool call', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-pending-block-'));
    cleanupDirs.add(cwd);
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const transcriptPath = join(cwd, 'session.jsonl');
    const firstEventStore = new FileEventStore(eventPath);
    const approvalStore = new EventBackedApprovalStore(firstEventStore, 'session-pending-1');
    const firstLoop = new RawAgentLoop({
      modelAdapter: new ToolCallOnlyAdapter(),
      eventStore: firstEventStore,
      approvalStore,
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime(),
    });

    await new Promise<void>((resolve) => {
      const iterator = firstLoop.run(
        {
          message: { channel: 'web', chatId: 'chat-1', content: '写文件' },
          prompt: '写文件',
          instructions: '必须调用工具。',
          maxTurns: 4,
          connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
        },
        {
          runId: 'run-pending-1',
          sessionId: 'session-pending-1',
          model: 'gpt-5.5',
          cwd,
          channelContext: {
            channel: 'web',
            user: { id: 'admin-1', username: 'admin', role: 'admin' },
          },
          hooks: {
            onInteraction: async () => {
              resolve();
              return new Promise(() => {});
            },
          },
        },
      )[Symbol.asyncIterator]();
      void iterator.next();
    });

    const finalAdapter = new FinalTextAdapter();
    const secondEventStore = new FileEventStore(eventPath);
    const secondLoop = new RawAgentLoop({
      modelAdapter: finalAdapter,
      eventStore: secondEventStore,
      approvalStore: new EventBackedApprovalStore(secondEventStore, 'session-pending-1'),
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime(),
    });

    const events = await collect(secondLoop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '继续' },
        prompt: '继续',
        instructions: '继续。',
        maxTurns: 4,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'run-pending-2',
        sessionId: 'session-pending-1',
        model: 'gpt-5.5',
        cwd,
        channelContext: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
      },
    ));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error' });
    expect(events[0]?.error).toContain('等待工具审批');
    expect(finalAdapter.requests).toHaveLength(0);
  });

  it('recovers an orphaned tool call with a synthetic tool result before accepting a new run', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-orphan-recover-'));
    cleanupDirs.add(cwd);
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const transcriptPath = join(cwd, 'session.jsonl');
    const eventStore = new FileEventStore(eventPath);
    await eventStore.append({
      type: 'assistant_tool_calls',
      runId: 'run-orphan-1',
      sessionId: 'session-orphan-1',
      content: '',
      toolCalls: [{
        id: 'call_orphan_1',
        name: 'Read',
        arguments: JSON.stringify({ path: 'missing.txt' }),
      }],
    });

    const adapter = new FinalTextAdapter();
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-orphan-1'),
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime(),
    });

    const events = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '继续' },
        prompt: '继续',
        instructions: '继续。',
        maxTurns: 4,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'run-orphan-2',
        sessionId: 'session-orphan-1',
        model: 'gpt-5.5',
        cwd,
        channelContext: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
      },
    ));

    expect(events.map((event) => event.type)).toContain('done');
    expect(adapter.requests).toHaveLength(1);
    const eventLog = readFileSync(eventPath, 'utf8');
    expect(eventLog).toContain('"type":"tool_result"');
    expect(eventLog).toContain('tool execution was interrupted before producing a result');
  });

  it('keeps an in-flight tool invocation blocked instead of synthesizing an unsafe result', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-running-block-'));
    cleanupDirs.add(cwd);
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const transcriptPath = join(cwd, 'session.jsonl');
    const eventStore = new FileEventStore(eventPath);
    await eventStore.append({
      type: 'assistant_tool_calls',
      runId: 'run-running-1',
      sessionId: 'session-running-1',
      content: '',
      toolCalls: [{
        id: 'call_running_1',
        name: 'Shell',
        arguments: JSON.stringify({ command: 'sleep 30' }),
      }],
    });
    await eventStore.append({
      type: 'tool_invocation_started',
      runId: 'run-running-1',
      sessionId: 'session-running-1',
      invocationId: 'inv-running-1',
      toolCallId: 'call_running_1',
      toolName: 'Shell',
      executionTarget: 'server-local',
    });

    const adapter = new FinalTextAdapter();
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-running-1'),
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime(),
    });

    const events = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '继续' },
        prompt: '继续',
        instructions: '继续。',
        maxTurns: 4,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'run-running-2',
        sessionId: 'session-running-1',
        model: 'gpt-5.5',
        cwd,
        channelContext: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
      },
    ));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error' });
    expect(events[0]?.error).toContain('仍在执行或等待恢复');
    expect(adapter.requests).toHaveLength(0);
  });

  it('recovers a zombie tool invocation (SIGKILL/crash 残留) instead of blocking forever', async () => {
    // 06-24 回归：session 3cab86d1 case —— server SIGKILL 后 invocation_started
    // 永远没等到 completed/cancel，PR #9 单纯第三类 blocking 会让会话永久卡死。
    // 用 zombieToolCallTimeoutMs:0 把所有 in-flight 即刻视为 zombie，强制走 recovery。
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-zombie-recover-'));
    cleanupDirs.add(cwd);
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const transcriptPath = join(cwd, 'session.jsonl');
    const eventStore = new FileEventStore(eventPath);
    await eventStore.append({
      type: 'assistant_tool_calls',
      runId: 'run-zombie-1',
      sessionId: 'session-zombie-1',
      content: '',
      toolCalls: [{
        id: 'call_zombie_1',
        name: 'Shell',
        arguments: JSON.stringify({ command: 'sleep 30' }),
      }],
    });
    await eventStore.append({
      type: 'tool_invocation_started',
      runId: 'run-zombie-1',
      sessionId: 'session-zombie-1',
      invocationId: 'inv-zombie-1',
      toolCallId: 'call_zombie_1',
      toolName: 'Shell',
      executionTarget: 'server-local',
    });

    const adapter = new FinalTextAdapter();
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-zombie-1'),
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime(),
      // 阈值 0 = invocationStarted 已存在即视为 zombie（仅测试用）。
      zombieToolCallTimeoutMs: 0,
    });

    const events = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '继续' },
        prompt: '继续',
        instructions: '继续。',
        maxTurns: 4,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'run-zombie-2',
        sessionId: 'session-zombie-1',
        model: 'gpt-5.5',
        cwd,
        channelContext: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
      },
    ));

    expect(events.map((event) => event.type)).toContain('done');
    expect(adapter.requests).toHaveLength(1);
    const eventLog = readFileSync(eventPath, 'utf8');
    expect(eventLog).toContain('"type":"tool_result"');
    // zombie 路径走 buildSyntheticToolResultContent 的 default 分支：
    expect(eventLog).toContain('tool execution was interrupted before producing a result');
  });

  it('keeps a fresh in-flight tool invocation blocked even when zombie threshold is configured', async () => {
    // 边界：设了较大阈值（5 分钟），新近 started 的 invocation 还没到 zombie 年龄，
    // 应当维持 PR #9 的 blocking 行为，避免误杀真正还在跑的 client daemon 工具。
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-fresh-block-'));
    cleanupDirs.add(cwd);
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const transcriptPath = join(cwd, 'session.jsonl');
    const eventStore = new FileEventStore(eventPath);
    await eventStore.append({
      type: 'assistant_tool_calls',
      runId: 'run-fresh-1',
      sessionId: 'session-fresh-1',
      content: '',
      toolCalls: [{
        id: 'call_fresh_1',
        name: 'Shell',
        arguments: JSON.stringify({ command: 'sleep 1' }),
      }],
    });
    await eventStore.append({
      type: 'tool_invocation_started',
      runId: 'run-fresh-1',
      sessionId: 'session-fresh-1',
      invocationId: 'inv-fresh-1',
      toolCallId: 'call_fresh_1',
      toolName: 'Shell',
      executionTarget: 'server-local',
    });

    const adapter = new FinalTextAdapter();
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-fresh-1'),
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime(),
      zombieToolCallTimeoutMs: 5 * 60_000,
    });

    const events = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '继续' },
        prompt: '继续',
        instructions: '继续。',
        maxTurns: 4,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'run-fresh-2',
        sessionId: 'session-fresh-1',
        model: 'gpt-5.5',
        cwd,
        channelContext: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
      },
    ));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error' });
    expect(events[0]?.error).toContain('仍在执行或等待恢复');
    expect(adapter.requests).toHaveLength(0);
  });

  // ── 跨 run Responses 接力：模型匹配防线（2026-07-02 切模型 PreviousResponseNotFound 事故） ──

  function relayFixtures(state: LatestResponseSessionState | null) {
    const patches: Array<{ runId: string; patch: ResponseSessionStatePatch }> = [];
    const runStore = {
      findLatestResponseSessionStateBySession: async () => state,
      updateResponseSessionState: async (runId: string, patch: ResponseSessionStatePatch) => {
        patches.push({ runId, patch });
        return null;
      },
    } as unknown as RunStore;
    return { runStore, patches };
  }

  class ResponseIdTextAdapter implements ModelAdapter {
    requests: ModelRequest[] = [];

    constructor(private readonly responseId: string) {}

    async *stream(request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
      this.requests.push(request);
      yield { type: 'text_delta', content: 'ok' };
      yield {
        type: 'completed',
        content: 'ok',
        toolCalls: [],
        responseId: this.responseId,
        usage: { inputTokens: 3, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      };
    }
  }

  async function runRelayScenario(
    state: LatestResponseSessionState | null,
    currentModel: string,
  ): Promise<{ adapter: ResponseIdTextAdapter; patches: Array<{ runId: string; patch: ResponseSessionStatePatch }> }> {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-relay-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'));
    const adapter = new ResponseIdTextAdapter('resp_new_run');
    const { runStore, patches } = relayFixtures(state);
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-relay-1'),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new PlatformToolRuntime(),
      runStore,
    });
    await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '继续' },
        prompt: '继续',
        instructions: '继续。',
        maxTurns: 2,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'run-relay-2',
        sessionId: 'session-relay-1',
        model: currentModel,
        cwd,
        channelContext: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
      },
    ));
    return { adapter, patches };
  }

  it('上一 run 同模型时跨 run 接力 previousResponseId', async () => {
    const { adapter } = await runRelayScenario(
      { runId: 'run-relay-1', lastResponseId: 'resp_prev', lastResponseModel: 'glm-5.2' },
      'glm-5.2',
    );
    expect(adapter.requests[0]?.previousResponseId).toBe('resp_prev');
  });

  it('上一 run 模型不同时禁止接力（切模型后 response id 属于旧后端）', async () => {
    const { adapter } = await runRelayScenario(
      { runId: 'run-relay-1', lastResponseId: 'resp_prev', lastResponseModel: 'gpt-5.5' },
      'glm-5.2',
    );
    expect(adapter.requests[0]?.previousResponseId).toBeUndefined();
  });

  it('存量数据缺 lastResponseModel 时视为身份未知，不接力', async () => {
    const { adapter } = await runRelayScenario(
      { runId: 'run-relay-1', lastResponseId: 'resp_prev' },
      'glm-5.2',
    );
    expect(adapter.requests[0]?.previousResponseId).toBeUndefined();
  });

  it('completed 带 responseId 时把当前模型作为接力身份键落库', async () => {
    const { patches } = await runRelayScenario(null, 'glm-5.2');
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      runId: 'run-relay-2',
      patch: { lastResponseId: 'resp_new_run', lastResponseModel: 'glm-5.2' },
    });
  });
});

describe('RawAgentLoop.compact（/compact 真实现）', () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    cleanupDirs.clear();
  });

  class SummaryAdapter implements ModelAdapter {
    requests: ModelRequest[] = [];
    constructor(private readonly summaryChunks: string[]) {}

    async *stream(request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
      this.requests.push(request);
      for (const chunk of this.summaryChunks) {
        yield { type: 'text_delta', content: chunk };
      }
      yield {
        type: 'completed',
        content: this.summaryChunks.join(''),
        toolCalls: [],
        usage: { inputTokens: 500, outputTokens: 60 },
      };
    }
  }

  async function makeCompactHarness(adapter: ModelAdapter) {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-compact-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'));
    const clearedSessions: string[] = [];
    const runStore = {
      upsertPending: vi.fn(),
      markStatus: vi.fn(),
      get: vi.fn().mockResolvedValue(null),
      findByIdempotencyKey: vi.fn().mockResolvedValue(null),
      listRecoverable: vi.fn().mockResolvedValue([]),
      clearResponseSessionStateBySession: vi.fn(async (sessionId: string) => {
        clearedSessions.push(sessionId);
        return 2;
      }),
    } as unknown as RunStore;
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-compact'),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new PlatformToolRuntime(),
      runStore,
    });
    const context: RunContext = {
      runId: 'run-compact-1',
      sessionId: 'session-compact',
      model: 'glm-5.2',
      cwd,
      channelContext: {
        channel: 'web',
        user: { id: 'user-1', username: 'leo', role: 'user' },
      },
    };
    return { cwd, eventStore, loop, context, clearedSessions };
  }

  async function seedHistory(eventStore: FileEventStore) {
    await eventStore.append({ type: 'user_message', runId: 'run-old-1', sessionId: 'session-compact', content: '帮我分析 A 方案' });
    await eventStore.append({ type: 'assistant_message', runId: 'run-old-1', sessionId: 'session-compact', content: 'A 方案的结论是 X=42。' });
    await eventStore.append({ type: 'user_message', runId: 'run-old-2', sessionId: 'session-compact', content: '再对比 B 方案' });
    await eventStore.append({ type: 'assistant_message', runId: 'run-old-2', sessionId: 'session-compact', content: 'B 方案成本更低，推荐 B。' });
  }

  it('成功链路：事件顺序、摘要落库、接力链清空、后续投影只剩 summary', async () => {
    const adapter = new SummaryAdapter(['## 摘要\n', '用户对比了 A/B 方案，结论：推荐 B（成本更低），A 的结论是 X=42。']);
    const { eventStore, loop, context, clearedSessions } = await makeCompactHarness(adapter);
    await seedHistory(eventStore);

    const outbound = await collect(loop.compact(
      { message: { channel: 'web', chatId: 'chat-1', content: '/compact' } },
      context,
    ));

    // 出站流：正常 text 流 + done
    expect(outbound[0]).toEqual({ type: 'text_start' });
    expect(outbound.at(-1)).toEqual({ type: 'done' });
    const streamedText = outbound.filter((e) => e.type === 'text_delta').map((e: any) => e.content).join('');
    expect(streamedText).toContain('推荐 B');
    expect(streamedText).toContain('上下文已压缩');

    // 摘要请求形态：压缩指令 system + 历史 + 请求语，无工具、无接力
    expect(adapter.requests).toHaveLength(1);
    const request = adapter.requests[0]!;
    expect(request.messages[0]).toMatchObject({ role: 'system' });
    expect(request.messages[0]?.content).toContain('上下文压缩助手');
    expect(request.messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('压缩以上对话历史') });
    expect(request.messages.map((m) => m.content)).toContain('帮我分析 A 方案');
    expect(request.tools).toEqual([]);
    expect(request.previousResponseId).toBeUndefined();

    // 事件落库顺序（compaction 必须在 assistant_message 之后、run_finished 之前）
    const events = await eventStore.list('session-compact');
    const types = events.map((e) => e.type);
    const idx = (t: string) => types.lastIndexOf(t as never);
    expect(idx('run_started')).toBeGreaterThanOrEqual(0);
    expect(idx('user_message')).toBeLessThan(idx('assistant_message'));
    expect(idx('assistant_message')).toBeLessThan(idx('compaction'));
    expect(idx('compaction')).toBeLessThan(idx('run_finished'));

    const compaction = events.find((e) => e.type === 'compaction') as any;
    expect(compaction.summary).toContain('推荐 B');
    expect(compaction.summary).not.toContain('上下文已压缩'); // 统计尾部不进 summary
    expect(compaction.coveredEventCount).toBe(4 + 3);

    const userMessage = events.find((e) => e.type === 'user_message' && e.runId === 'run-compact-1') as any;
    expect(userMessage.content).toBe('/compact');
    expect(userMessage.modelContent).toContain('[系统命令]');

    const runFinished = events.find((e) => e.type === 'run_finished') as any;
    expect(runFinished.subtype).toBe('success');
    expect(runFinished.modelUsage?.['glm-5.2']).toMatchObject({ inputTokens: 500, outputTokens: 60 });

    // 接力链已按 session 清空
    expect(clearedSessions).toEqual(['session-compact']);

    // 闭环：下一个 run 的投影只剩 summary（历史与本 run 的 user/assistant 全部被盖掉）
    const projection = buildContextProjection(await eventStore.list('session-compact'), {
      sessionId: 'session-compact',
      runId: 'run-next',
    });
    expect(projection.messages).toHaveLength(1);
    expect(projection.messages[0]).toMatchObject({ role: 'user' });
    expect(projection.messages[0]?.content).toContain('<context-summary>');
    expect(projection.messages[0]?.content).toContain('推荐 B');
    expect(projection.messages[0]?.content).not.toContain('/compact');
  });

  it('历史太短：直接回复无需压缩，不产生 compaction 事件', async () => {
    const adapter = new SummaryAdapter(['不应被调用']);
    const { eventStore, loop, context } = await makeCompactHarness(adapter);

    const outbound = await collect(loop.compact(
      { message: { channel: 'web', chatId: 'chat-1', content: '/compact' } },
      context,
    ));

    expect(adapter.requests).toHaveLength(0);
    expect(outbound.at(-1)).toEqual({ type: 'done' });
    const streamedText = outbound.filter((e) => e.type === 'text_delta').map((e: any) => e.content).join('');
    expect(streamedText).toContain('无需压缩');
    const events = await eventStore.list('session-compact');
    expect(events.some((e) => e.type === 'compaction')).toBe(false);
    expect((events.find((e) => e.type === 'run_finished') as any)?.subtype).toBe('success');
  });

  it('模型返回空摘要：run_finished error，无 compaction，防御性 modelContent 保证投影无裸 /compact', async () => {
    class EmptyAdapter implements ModelAdapter {
      async *stream(_request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
        yield { type: 'completed', content: '', toolCalls: [] };
      }
    }
    const { eventStore, loop, context, clearedSessions } = await makeCompactHarness(new EmptyAdapter());
    await seedHistory(eventStore);

    const outbound = await collect(loop.compact(
      { message: { channel: 'web', chatId: 'chat-1', content: '/compact' } },
      context,
    ));

    expect(outbound.at(-1)).toMatchObject({ type: 'error' });
    expect((outbound.at(-1) as any).error).toContain('压缩失败');
    const events = await eventStore.list('session-compact');
    expect(events.some((e) => e.type === 'compaction')).toBe(false);
    expect((events.find((e) => e.type === 'run_finished') as any)?.subtype).toBe('error');
    expect(clearedSessions).toEqual([]); // 失败时不清接力链

    // 残留的 /compact user_message 投影后是防御说明文本，不是裸命令
    const projection = buildContextProjection(events, { sessionId: 'session-compact', runId: 'run-next' });
    const lastUser = projection.messages.filter((m) => m.role === 'user').at(-1);
    expect(lastUser?.content).toContain('[系统命令]');
    expect(lastUser?.content).not.toBe('/compact');
  });
});
