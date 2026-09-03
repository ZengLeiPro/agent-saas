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
import { WEB_FETCH_CONSECUTIVE_FAILURE_LIMIT, WebToolProvider } from '../agent/webToolProvider.js';
import { EventBackedApprovalStore } from '../runtime/approvalStore.js';
import { buildContextProjection } from '../runtime/contextProjection.js';
import { FileEventStore } from '../runtime/fileEventStore.js';
import { LegacyTranscriptProjection } from '../runtime/legacyTranscriptProjection.js';
import { RawAgentLoop } from '../runtime/rawAgentLoop.js';
import { MODEL_TOOL_RESULT_MAX_CHARS } from '../runtime/replayEventBounds.js';
import { SessionContextService, SessionToolProvider } from '../runtime/sessionContext.js';
import { InMemoryToolInvocationStore } from '../runtime/toolInvocationStore.js';
import type { LatestResponseSessionState, ResponseSessionStatePatch, RunStore } from '../runtime/runStore.js';
import { ModelProviderError } from '../runtime/types.js';
import type {
  ModelAdapter,
  ModelEvent,
  ModelRequest,
  ModelToolCall,
  PlatformEvent,
  QueuedInterjection,
  RunContext,
} from '../runtime/types.js';
import type { OutboundEvent } from '../types/index.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { configureModelPricing } from '../data/usage/pricing.js';
import { seedCompleteParallelToolUnit } from './rawAgentLoop.testHelpers.js';

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

class DrainAfterToolCallAdapter implements ModelAdapter {
  calls = 0;

  constructor(private readonly handoff: { requested: boolean }) {}

  async *stream(_request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    this.calls += 1;
    yield {
      type: 'completed',
      content: '',
      toolCalls: [{
        id: 'call_write_before_handoff',
        name: 'Write',
        arguments: JSON.stringify({ path: 'handoff.txt', content: 'CLOSED_BEFORE_HANDOFF' }),
      }],
    };
    this.handoff.requested = true;
  }
}

class ForcedDrainAdapter implements ModelAdapter {
  constructor(
    private readonly controller: AbortController,
    private readonly handoff: { requested: boolean; reason?: string },
  ) {}

  async *stream(_request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    yield { type: 'text_delta', content: '已完成的部分' };
    this.handoff.requested = true;
    this.handoff.reason = 'server_drain_handoff';
    this.controller.abort(new Error('server_drain_deadline'));
    throw this.controller.signal.reason;
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

class WebFetchUntilForcedSynthesisAdapter implements ModelAdapter {
  calls = 0;
  requests: ModelRequest[] = [];

  async *stream(request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    this.calls += 1;
    this.requests.push(request);
    if (request.toolChoice === 'none') {
      yield { type: 'text_delta', content: '基于已有材料收束。' };
      yield { type: 'completed', content: '基于已有材料收束。', toolCalls: [] };
      return;
    }
    yield {
      type: 'completed',
      content: '',
      toolCalls: [{
        id: `call_fetch_${this.calls}`,
        name: 'WebFetch',
        arguments: JSON.stringify({ url: `https://93.184.216.34/missing-${this.calls}` }),
      }],
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

class InterjectionAfterFinalAdapter implements ModelAdapter {
  calls = 0;
  requests: ModelRequest[] = [];

  async *stream(request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    this.calls += 1;
    this.requests.push(request);
    const content = this.calls === 1 ? '第一段回答。' : '已按插话修正。';
    yield { type: 'text_delta', content };
    yield { type: 'completed', content, toolCalls: [] };
  }
}

class AbortBeforeInterjectionEventAdapter implements ModelAdapter {
  calls = 0;

  constructor(private readonly controller: AbortController) {}

  async *stream(_request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    this.calls += 1;
    if (this.calls === 1) {
      yield { type: 'text_delta', content: '第一段回答。' };
      yield { type: 'completed', content: '第一段回答。', toolCalls: [] };
      return;
    }
    this.controller.abort(new Error('cancelled before interjection model event'));
    throw this.controller.signal.reason;
  }
}

class FailedBeforeInterjectionEventAdapter implements ModelAdapter {
  calls = 0;

  async *stream(_request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    this.calls += 1;
    if (this.calls === 1) {
      yield { type: 'text_delta', content: '第一段回答。' };
      yield { type: 'completed', content: '第一段回答。', toolCalls: [] };
      return;
    }
    yield {
      type: 'completed',
      content: '',
      toolCalls: [],
      terminalStatus: 'incomplete',
      incompleteReason: 'max_output_tokens',
      finishReason: 'length',
    };
  }
}

class InterjectionAfterToolAdapter implements ModelAdapter {
  calls = 0;
  requests: ModelRequest[] = [];

  async *stream(request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    this.calls += 1;
    this.requests.push(request);
    if (this.calls === 1) {
      yield {
        type: 'completed',
        content: '先读取文件。',
        toolCalls: [{
          id: 'call_read_interjection',
          name: 'Read',
          arguments: JSON.stringify({ path: 'seed.txt' }),
        }],
      };
      return;
    }
    yield { type: 'text_delta', content: '已结合两条插话回答。' };
    yield {
      type: 'completed',
      content: '已结合两条插话回答。',
      toolCalls: [],
      usage: { inputTokens: 8, outputTokens: 3 },
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

class PartialFailureAdapter implements ModelAdapter {
  async *stream(_request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    yield { type: 'text_delta', content: '已经生成但尚未完成' };
    yield {
      type: 'completed',
      content: '已经生成但尚未完成',
      toolCalls: [],
      terminalStatus: 'failed',
      errorCode: 'internal_server_error',
    };
  }
}

class IncompleteToolCallAdapter implements ModelAdapter {
  async *stream(_request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    yield {
      type: 'completed',
      content: '',
      toolCalls: [{
        id: 'call_incomplete_write',
        name: 'Write',
        arguments: JSON.stringify({ path: 'must-not-exist.txt', content: 'unsafe' }),
      }],
      terminalStatus: 'incomplete',
      incompleteReason: 'max_output_tokens',
      finishReason: 'length',
      responseId: 'resp_incomplete_must_not_persist',
      usage: { inputTokens: 100, outputTokens: 4096 },
    };
  }
}

class DiagnosticTextAdapter implements ModelAdapter {
  async *stream(_request: ModelRequest, context: RunContext): AsyncIterable<ModelEvent> {
    const modelRequestId = 'model-request-persisted';
    const attemptId = 'attempt-persisted';
    await context.recordModelRequestDiagnostic?.({
      type: 'started',
      modelRequestId,
      attemptId,
      attempt: 1,
      clientRequestId: 'client-request-persisted',
      model: context.model,
      protocol: 'responses',
      responseMode: 'full',
      outputTransactionMode: 'irreversible_stream',
      maxOutputTokens: 4096,
      requestBodyBytes: 123,
      toolsCount: 0,
      hasPreviousResponseId: false,
    });
    await context.recordModelRequestDiagnostic?.({
      type: 'checkpoint',
      modelRequestId,
      attemptId,
      attempt: 1,
      stage: 'response_created',
      elapsedMs: 5,
      responseIdHash: 'hashed-response-id',
    });
    await context.recordModelRequestDiagnostic?.({
      type: 'finished',
      modelRequestId,
      attemptId,
      attempt: 1,
      outcome: 'completed',
      durationMs: 10,
      terminalStatus: 'completed',
    });
    yield { type: 'text_delta', content: '完成' };
    yield { type: 'completed', content: '完成', toolCalls: [], terminalStatus: 'completed' };
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

class ReplaceableDraftAdapter implements ModelAdapter {
  async *stream(_request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    yield { type: 'thinking_delta', content: '失败轮思考' };
    yield { type: 'text_delta', content: '失败轮正文' };
    yield { type: 'draft_reset', attempt: 1 };
    yield { type: 'thinking_delta', content: '成功轮思考' };
    yield { type: 'text_delta', content: '最终答案' };
    yield {
      type: 'completed',
      content: '最终答案',
      toolCalls: [],
      terminalStatus: 'completed',
      modelRequestAttemptCount: 2,
      usage: { inputTokens: 4, outputTokens: 3 },
    };
  }
}

class RestartedDraftAdapter implements ModelAdapter {
  retryUsed: boolean[] = [];

  async *stream(_request: ModelRequest, context: RunContext): AsyncIterable<ModelEvent> {
    this.retryUsed.push(context.replaceableDraftRetryUsed === true);
    yield { type: 'text_delta', content: '重启后答案' };
    yield {
      type: 'completed',
      content: '重启后答案',
      toolCalls: [],
      terminalStatus: 'completed',
    };
  }
}

class ThinkingOnlyThenTextAdapter implements ModelAdapter {
  calls = 0;
  requests: ModelRequest[] = [];

  async *stream(request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    this.calls += 1;
    this.requests.push(request);
    if (this.calls === 1) {
      yield { type: 'thinking_delta', content: '已经想好下一步。' };
      yield {
        type: 'completed',
        content: '',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      };
      return;
    }
    yield { type: 'text_delta', content: '继续完成' };
    yield {
      type: 'completed',
      content: '继续完成',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 3, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    };
  }
}

class CountingToolRuntime implements ToolRuntime {
  invocations = 0;

  list(): ToolDescriptor[] {
    return [writeFileToolDescriptor];
  }

  async invoke<TInput>(_call: AuthorizedToolCall<TInput>, _context: ToolCallContext): Promise<ToolResult> {
    this.invocations += 1;
    return { content: 'unexpected execution' };
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

class RepeatedLongToolAdapter implements ModelAdapter {
  calls = 0;
  requests: ModelRequest[] = [];

  async *stream(request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    this.calls += 1;
    this.requests.push(request);
    if (this.calls <= 10) {
      yield {
        type: 'completed',
        content: '',
        toolCalls: [{
          id: `call-long-${this.calls}`,
          name: 'Write',
          arguments: JSON.stringify({ path: `result-${this.calls}.txt`, content: 'ignored' }),
        }],
      };
      return;
    }
    yield { type: 'text_delta', content: '完成' };
    yield { type: 'completed', content: '完成', toolCalls: [] };
  }
}

class LongResultToolRuntime implements ToolRuntime {
  readonly content = `LONG_RESULT_START\n${'X'.repeat(30_000)}\nLONG_RESULT_END`;

  list(): ToolDescriptor[] {
    return [writeFileToolDescriptor];
  }

  async invoke<TInput>(_call: AuthorizedToolCall<TInput>, _context: ToolCallContext): Promise<ToolResult> {
    return { content: this.content };
  }
}

class InvalidPromptRecoveryAdapter implements ModelAdapter {
  readonly capabilities = { responseState: 'stored' as const };
  readonly requests: ModelRequest[] = [];

  constructor(
    private readonly failures: number,
    private readonly failure: Partial<Extract<ModelEvent, { type: 'completed' }>> = {},
    private readonly throwTypedError = false,
    private readonly outputBeforeFailure?: 'text' | 'thinking',
  ) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    if (this.requests.length <= this.failures) {
      if (this.outputBeforeFailure === 'text') yield { type: 'text_delta', content: '部分正文' };
      if (this.outputBeforeFailure === 'thinking') yield { type: 'thinking_delta', content: '部分思考' };
      if (this.throwTypedError) {
        throw new ModelProviderError(
          'Responses API HTTP 400: Request blocked by provider',
          400,
          'invalid_prompt',
          `request-${this.requests.length}`,
          `attempt-${this.requests.length}`,
          0,
        );
      }
      yield {
        type: 'completed',
        content: '',
        toolCalls: [],
        terminalStatus: 'failed',
        errorCode: 'invalid_prompt',
        errorMessage: 'Request blocked by provider',
        modelRequestId: `request-${this.requests.length}`,
        attemptId: `attempt-${this.requests.length}`,
        emittedOutputCount: 0,
        providerStatus: 400,
        ...this.failure,
      };
      return;
    }
    yield { type: 'text_delta', content: '恢复完成' };
    yield { type: 'completed', content: '恢复完成', toolCalls: [], terminalStatus: 'completed' };
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

  it('invalid_prompt Request blocked 零输出时排除最后完整工具单元并在同一 run 自动继续', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-context-rewind-'));
    cleanupDirs.add(cwd);
    const sessionId = 'session-context-rewind';
    const runId = 'run-context-rewind';
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const transcriptPath = join(cwd, 'session.jsonl');
    const eventStore = new FileEventStore(eventPath, DEFAULT_TENANT_ID);
    const originals = await seedCompleteParallelToolUnit(eventStore, sessionId);
    const originalSnapshot = JSON.stringify(originals);
    const adapter = new InvalidPromptRecoveryAdapter(1, {}, true);
    const clearResponseSessionStateBySession = vi.fn(async () => 1);
    const runStore = {
      findLatestResponseSessionStateBySession: async () => ({
        runId: 'run-history',
        lastResponseId: 'resp-previous',
        lastResponseModel: 'gpt-5.6-sol',
        lastResponseProfileDigest: 'profile-digest',
      }),
      clearResponseSessionStateBySession,
    } as unknown as RunStore;
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, sessionId, DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      runStore,
    });

    const outbound = await collect(loop.run({
      message: { channel: 'web', chatId: sessionId, content: '处理后续' },
      prompt: '处理后续',
      instructions: 'system instructions',
      maxTurns: 1,
      connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
    }, {
      runId,
      sessionId,
      model: 'gpt-5.6-sol',
      profileConfigDigest: 'profile-digest',
      cwd, tenantId: DEFAULT_TENANT_ID,
      channelContext: { channel: 'web' },
      approvalPolicy: { autoApproveTools: true },
    }));

    expect(outbound.at(-1)).toEqual({ type: 'done' });
    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[0]?.previousResponseId).toBe('resp-previous');
    expect(adapter.requests[1]?.previousResponseId).toBeUndefined();
    expect(clearResponseSessionStateBySession).toHaveBeenCalledOnce();
    const replay = adapter.requests[1]!.messages;
    expect(replay.at(-1)).toEqual({ role: 'user', content: '继续' });
    expect(replay.some((message) => message.role === 'system'
      && message.content.includes('禁止盲目重复写操作'))).toBe(true);
    expect(replay.some((message) => message.role === 'assistant' && message.tool_calls?.length)).toBe(false);
    expect(replay.some((message) => message.role === 'tool')).toBe(false);
    expect(replay.some((message) => message.role === 'assistant' && message.provider_continuation)).toBe(false);

    const durable = await eventStore.list(DEFAULT_TENANT_ID, sessionId);
    expect(JSON.stringify(durable.slice(0, originals.length))).toBe(originalSnapshot);
    const rewind = durable.find((item): item is Extract<PlatformEvent, { type: 'context_rewind' }> => (
      item.type === 'context_rewind'
    ));
    expect(rewind).toMatchObject({
      runId,
      reason: 'invalid_prompt_request_blocked',
      message: '自动回退上一工具交互并继续',
      sourceModelRequestId: 'request-1',
      sourceAttemptId: 'attempt-1',
      excludedEventIds: originals.slice(1).map((item) => item.id),
      excludedToolCallIds: ['call-read', 'call-shell'],
      excludedStartSequence: 2,
      excludedEndSequence: 5,
      recoveryAttempt: 1,
    });
    expect(durable.filter((item) => item.type === 'context_rewind')).toHaveLength(1);
    expect(durable.filter((item) => item.type === 'user_message'
      && item.systemGenerated === true
      && item.content === '继续')).toHaveLength(1);
    expect(durable.filter((item) => item.type === 'run_finished')).toEqual([
      expect.objectContaining({ subtype: 'success' }),
    ]);
    const sessionContextPage = await new SessionContextService(eventStore, DEFAULT_TENANT_ID).getEvents(sessionId, { limit: 100 });
    expect(sessionContextPage.events.slice(0, originals.length).map((item) => item.id))
      .toEqual(originals.map((item) => item.id));
    expect(await readFile(transcriptPath, 'utf-8')).not.toContain('"content":"继续"');
  });

  it('同一 run 第二次 Request blocked 不再截断并只返回客户继续提示', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-context-rewind-once-'));
    cleanupDirs.add(cwd);
    const sessionId = 'session-context-rewind-once';
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    await seedCompleteParallelToolUnit(eventStore, sessionId);
    const adapter = new InvalidPromptRecoveryAdapter(2);
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, sessionId, DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
    });

    const outbound = await collect(loop.run({
      message: { channel: 'web', chatId: sessionId, content: '继续处理' },
      prompt: '继续处理',
      instructions: 'system instructions',
      maxTurns: 1,
      connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
    }, {
      runId: 'run-context-rewind-once',
      sessionId,
      model: 'gpt-5.6-sol',
      cwd, tenantId: DEFAULT_TENANT_ID,
      channelContext: { channel: 'web' },
      approvalPolicy: { autoApproveTools: true },
    }));

    expect(adapter.requests).toHaveLength(2);
    expect(outbound.at(-1)).toEqual({ type: 'error', error: 'Agent 开小差了，请发送「继续」' });
    const durable = await eventStore.list(DEFAULT_TENANT_ID, sessionId);
    expect(durable.filter((item) => item.type === 'context_rewind')).toHaveLength(1);
    expect(durable.filter((item) => item.type === 'user_message' && item.systemGenerated)).toHaveLength(1);
    expect(durable.filter((item) => item.type === 'run_finished')).toEqual([
      expect.objectContaining({ subtype: 'error', error: 'Agent 开小差了，请发送「继续」' }),
    ]);
  });

  it('marker 写入后进程重启时 wake 不重复追加 marker 或“继续”', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-context-rewind-wake-'));
    cleanupDirs.add(cwd);
    const sessionId = 'session-context-rewind-wake';
    const runId = 'run-context-rewind-wake';
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const originals = await seedCompleteParallelToolUnit(eventStore, sessionId);
    await eventStore.appendBatch([
      {
        type: 'context_rewind',
        runId,
        sessionId,
        reason: 'invalid_prompt_request_blocked',
        message: '自动回退上一工具交互并继续',
        sourceModelRequestId: 'request-before-crash',
        sourceAttemptId: 'attempt-before-crash',
        excludedEventIds: originals.slice(1).map((item) => item.id),
        excludedToolCallIds: ['call-read', 'call-shell'],
        excludedStartSequence: 2,
        excludedEndSequence: 5,
        createdAt: new Date().toISOString(),
        recoveryAttempt: 1,
      },
      {
        type: 'user_message',
        runId,
        sessionId,
        content: '继续',
        modelContent: '继续',
        systemGenerated: true,
        recoveryKind: 'invalid_prompt_rewind',
        hiddenFromUserTranscript: true,
      },
    ], { tenantId: DEFAULT_TENANT_ID });
    const adapter = new InvalidPromptRecoveryAdapter(0);
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, sessionId, DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
    });

    const outbound = await collect(loop.run({
      message: { channel: 'web', chatId: sessionId, content: 'hidden scheduler wake' },
      prompt: 'hidden scheduler wake',
      instructions: 'system instructions',
      maxTurns: 1,
      recordUserMessage: false,
      connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
    }, {
      runId,
      sessionId,
      model: 'gpt-5.6-sol',
      cwd, tenantId: DEFAULT_TENANT_ID,
      channelContext: { channel: 'web' },
      approvalPolicy: { autoApproveTools: true },
    }));

    expect(outbound.at(-1)).toEqual({ type: 'done' });
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0]!.messages.filter((message) => (
      message.role === 'user' && message.content === '继续'
    ))).toHaveLength(1);
    expect(JSON.stringify(adapter.requests[0]!.messages)).not.toContain('hidden scheduler wake');
    const durable = await eventStore.list(DEFAULT_TENANT_ID, sessionId);
    expect(durable.filter((item) => item.type === 'context_rewind')).toHaveLength(1);
    expect(durable.filter((item) => item.type === 'user_message' && item.systemGenerated)).toHaveLength(1);
  });

  it('resumeApproval 路径同样只恢复一次并在原 durable run 成功收尾', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-context-rewind-resume-'));
    cleanupDirs.add(cwd);
    await writeFile(join(cwd, 'seed.txt'), 'SEED_OK', 'utf-8');
    const sessionId = 'session-context-rewind-resume';
    const runId = 'run-context-rewind-resume';
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const approvalStore = new EventBackedApprovalStore(eventStore, sessionId, DEFAULT_TENANT_ID);
    await eventStore.appendBatch([
      { type: 'user_message', runId, sessionId, content: '读取 seed.txt' },
      {
        type: 'assistant_tool_calls',
        runId,
        sessionId,
        content: '',
        toolCalls: [{ id: 'call-resume-read', name: 'Read', arguments: '{"path":"seed.txt"}' }],
      },
    ], { tenantId: DEFAULT_TENANT_ID });
    const approval = await approvalStore.create({
      sessionId,
      runId,
      toolCallId: 'call-resume-read',
      toolId: 'Read',
      toolName: 'Read',
      input: { path: 'seed.txt' },
    });
    const adapter = new InvalidPromptRecoveryAdapter(1);
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore,
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new PlatformToolRuntime(),
    });

    const outbound = await collect(loop.resumeApproval({
      approvalId: approval.id,
      response: { allow: true, message: '批准读取' },
      instructions: '读取后回答。',
      maxTurns: 1,
    }, {
      runId,
      sessionId,
      model: 'gpt-5.6-sol',
      cwd, tenantId: DEFAULT_TENANT_ID,
      channelContext: { channel: 'web' },
      approvalPolicy: { autoApproveTools: true },
    }));

    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[1]!.messages.at(-1)).toEqual({ role: 'user', content: '继续' });
    expect(outbound.at(-1)).toEqual({ type: 'done' });
    const durable = await eventStore.list(DEFAULT_TENANT_ID, sessionId);
    expect(durable.filter((item) => item.type === 'context_rewind')).toHaveLength(1);
    expect(durable.filter((item) => item.type === 'run_finished')).toEqual([
      expect.objectContaining({ subtype: 'success' }),
    ]);
  });

  it.each([
    ['其他 invalid_prompt', { errorMessage: 'Different validation error' }, true, undefined],
    ['其他错误码', { errorCode: 'server_error' }, true, undefined],
    ['已有模型正文输出', { emittedOutputCount: 1 }, true, 'text'],
    ['已有模型 thinking 输出', { emittedOutputCount: 1 }, true, 'thinking'],
    ['最后 assistant 轮不是工具交互', {}, false, undefined],
  ] as const)('%s 不触发 context_rewind', async (_name, failure, completeHistory, outputBeforeFailure) => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-context-rewind-negative-'));
    cleanupDirs.add(cwd);
    const sessionId = `session-negative-${cleanupDirs.size}`;
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    if (completeHistory) {
      await seedCompleteParallelToolUnit(eventStore, sessionId);
    } else {
      await eventStore.appendBatch([
        { type: 'user_message', runId: 'run-history', sessionId, content: '检查状态' },
        { type: 'assistant_message', runId: 'run-history', sessionId, content: '已检查' },
      ], { tenantId: DEFAULT_TENANT_ID });
    }
    const adapter = new InvalidPromptRecoveryAdapter(1, failure, false, outputBeforeFailure);
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, sessionId, DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
    });
    const outbound = await collect(loop.run({
      message: { channel: 'web', chatId: sessionId, content: '继续处理' },
      prompt: '继续处理',
      instructions: 'system instructions',
      maxTurns: 1,
      connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
    }, {
      runId: `run-${sessionId}`,
      sessionId,
      model: 'gpt-5.6-sol',
      cwd, tenantId: DEFAULT_TENANT_ID,
      channelContext: { channel: 'web' },
      approvalPolicy: { autoApproveTools: true },
    }));
    expect(adapter.requests).toHaveLength(1);
    const durable = await eventStore.list(DEFAULT_TENANT_ID, sessionId);
    expect(durable.some((item) => item.type === 'context_rewind')).toBe(false);
    if (outputBeforeFailure === 'text') {
      expect(durable).toContainEqual(expect.objectContaining({
        type: 'assistant_message',
        content: '部分正文',
        incomplete: true,
      }));
      expect(outbound.at(-1)).toEqual({
        type: 'error',
        error: 'Agent 开小差了，请发送「继续」；已保留本次未完成正文，可发送“继续”接着完成。',
      });
    }
    if (outputBeforeFailure === 'thinking') {
      expect(outbound).toContainEqual({ type: 'thinking_delta', content: '部分思考' });
    }
  });

  it('工具结果原文持久化，但模型投影固定且不会随新结果追加而改写', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-stable-tool-prefix-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const adapter = new RepeatedLongToolAdapter();
    const toolRuntime = new LongResultToolRuntime();
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-stable-tool-prefix', DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime,
    });

    const outbound = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '连续执行十次' },
        prompt: '连续执行十次',
        instructions: '按要求调用工具。',
        maxTurns: 12,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'run-stable-tool-prefix',
        sessionId: 'session-stable-tool-prefix',
        model: 'unconfigured-model',
        cwd,
        channelContext: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID },
        },
        approvalPolicy: { autoApproveTools: true },
      },
    ));

    expect(outbound.at(-1)).toEqual({ type: 'done' });
    const firstToolContents = adapter.requests.slice(1).map((request) => {
      const firstTool = request.messages.find((message) => message.role === 'tool');
      return firstTool?.role === 'tool' ? firstTool.content : undefined;
    });
    expect(firstToolContents).toHaveLength(10);
    expect(firstToolContents.every((content) => content === firstToolContents[0])).toBe(true);
    expect(Array.from(firstToolContents[0] ?? '')).toHaveLength(MODEL_TOOL_RESULT_MAX_CHARS);
    expect(firstToolContents[0]).toContain('toolCallId="call-long-1"');
    expect(firstToolContents[0]).toContain('startChar=2001');
    expect(firstToolContents[0]).toContain('query="关键字"');

    const durableToolResults = (await eventStore.list(DEFAULT_TENANT_ID, 'session-stable-tool-prefix'))
      .filter((event): event is Extract<PlatformEvent, { type: 'tool_result' }> => event.type === 'tool_result');
    expect(durableToolResults).toHaveLength(10);
    expect(durableToolResults.every((event) => event.content === toolRuntime.content)).toBe(true);
    expect(durableToolResults.every((event) => !('modelContent' in event))).toBe(true);
  });

  it('hands off only after the current tool-call batch is durably closed', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-drain-handoff-'));
    cleanupDirs.add(cwd);
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const eventStore = new FileEventStore(eventPath, DEFAULT_TENANT_ID);
    const drainHandoff = { requested: false };
    const adapter = new DrainAfterToolCallAdapter(drainHandoff);
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-drain-handoff', DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new PlatformToolRuntime(),
    });

    const events = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '写完后继续' },
        prompt: '写完后继续',
        instructions: '先调用 Write，再继续回答。',
        maxTurns: 4,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'run-drain-handoff',
        sessionId: 'session-drain-handoff',
        model: 'gpt-5.5',
        cwd,
        drainHandoff,
        channelContext: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID },
        },
        approvalPolicy: { autoApproveTools: true },
      },
    ));

    expect(readFileSync(join(cwd, 'handoff.txt'), 'utf-8')).toBe('CLOSED_BEFORE_HANDOFF');
    expect(adapter.calls).toBe(1);
    expect(events.map((event) => event.type)).toContain('tool_result');
    expect(events.map((event) => event.type)).not.toContain('done');
    const storedEvents = await eventStore.list(DEFAULT_TENANT_ID, 'session-drain-handoff');
    expect(storedEvents.map((event) => event.type)).not.toContain('run_finished');
  });

  it('does not terminalize a run when the drain deadline forces a handoff', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-forced-drain-handoff-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const abortController = new AbortController();
    const drainHandoff = { requested: false };
    const loop = new RawAgentLoop({
      modelAdapter: new ForcedDrainAdapter(abortController, drainHandoff),
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-forced-drain-handoff', DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new PlatformToolRuntime(),
    });

    const events = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '执行长任务' },
        prompt: '执行长任务',
        instructions: '执行任务。',
        maxTurns: 4,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'run-forced-drain-handoff',
        sessionId: 'session-forced-drain-handoff',
        model: 'gpt-5.5',
        cwd,
        signal: abortController.signal,
        drainHandoff, tenantId: DEFAULT_TENANT_ID,
        channelContext: { channel: 'web' },
      },
    ));

    expect(events.map((event) => event.type)).not.toContain('error');
    expect(events.map((event) => event.type)).not.toContain('done');
    const storedEvents = await eventStore.list(DEFAULT_TENANT_ID, 'session-forced-drain-handoff');
    expect(storedEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'assistant_message',
        content: '已完成的部分',
        incomplete: true,
      }),
    ]));
    expect(storedEvents.map((event) => event.type)).not.toContain('run_finished');
  });

  it('forces a no-tool synthesis turn after the WebFetch failure circuit opens', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-web-fetch-circuit-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const adapter = new WebFetchUntilForcedSynthesisAdapter();
    const fetchImpl = vi.fn(async () => new Response('missing', {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'text/plain' },
    })) as unknown as typeof fetch;
    const webProvider = new WebToolProvider({
      fetch: {},
      egress: { allowedHosts: ['93.184.216.34'] },
    }, fetchImpl);
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-web-fetch-circuit', DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new PlatformToolRuntime({ providers: [webProvider] }),
    });

    const events = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '调研' },
        prompt: '调研',
        instructions: '先找资料再回答。',
        maxTurns: WEB_FETCH_CONSECUTIVE_FAILURE_LIMIT + 2,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'run-web-fetch-circuit',
        sessionId: 'session-web-fetch-circuit',
        model: 'gpt-5.5',
        cwd, tenantId: DEFAULT_TENANT_ID,
        channelContext: { channel: 'web', user: { id: 'admin-1', username: 'admin', role: 'admin' } },
      },
    ));

    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(fetchImpl).toHaveBeenCalledTimes(WEB_FETCH_CONSECUTIVE_FAILURE_LIMIT);
    expect(adapter.requests.at(-1)?.toolChoice).toBe('none');
    expect(adapter.requests.at(-1)?.messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('WebFetch 已因持续高失败率熔断'),
    });
  });

  it('persists approval before executing Write and projects legacy transcript', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-'));
    cleanupDirs.add(cwd);
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const transcriptPath = join(cwd, 'session.jsonl');
    const adapter = new FakeToolCallingAdapter();
    const eventStore = new FileEventStore(eventPath, 'wain-test');
    const approvalStore = new EventBackedApprovalStore(eventStore, 'session-1', 'wain-test');
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
    const contextUsageEvents = events.filter((event) => event.type === 'context_usage');
    expect(contextUsageEvents).toHaveLength(2);
    expect(contextUsageEvents[0]?.contextUsage).toMatchObject({
      totalTokens: 25,
      cacheHitRatio: 0,
      cacheHitDenominatorTokens: 20,
      lastRequestCacheHitRatio: 0,
      lastRequestCacheHitDenominatorTokens: 20,
    });
    expect(contextUsageEvents[0]?.contextUsage?.maxTokens).toBeUndefined();
    expect(contextUsageEvents[1]?.contextUsage).toMatchObject({
      totalTokens: 14,
      cacheHitRatio: 0,
      cacheHitDenominatorTokens: 32,
      lastRequestCacheHitRatio: 0,
      lastRequestCacheHitDenominatorTokens: 12,
    });
    const invocation = await toolInvocationStore.get('run-1:call_write_1');
    expect(invocation?.status).toBe('completed');
    expect(invocation?.toolName).toBe('Write');
    expect(invocation?.tenantId).toBe('wain-test');
    expect(invocation?.metadata).toMatchObject({
      toolId: 'Write',
      toolInputDigest: '47c781d673dfb7199eba98f6bfa649a5f4e64460d310b769e5bf2b99165b5877',
    });
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
    const eventStore = new FileEventStore(eventPath, DEFAULT_TENANT_ID);
    const approvalStore = new EventBackedApprovalStore(eventStore, 'session-write-auto', DEFAULT_TENANT_ID);
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

  it('keeps account-level auto-approval when legacy run metadata has no approvalPolicy', async () => {
    // 授权模式对所有已认证用户生效（2026-07-02 起）：普通用户开启后
    // Write/Edit 免人工审批；存量/派生 run 缺少 metadata 字段时不能反向清空账户策略。
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-write-auto-user-'));
    cleanupDirs.add(cwd);
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const transcriptPath = join(cwd, 'session.jsonl');
    const eventStore = new FileEventStore(eventPath, 'wain-test');
    const approvalStore = new EventBackedApprovalStore(eventStore, 'session-write-auto-user', 'wain-test');
    const loop = new RawAgentLoop({
      modelAdapter: new FakeToolCallingAdapter(),
      eventStore,
      approvalStore,
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime(),
      runStore: {
        get: vi.fn(async () => ({ metadata: {} })),
      } as any,
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
    const eventStore = new FileEventStore(eventPath, DEFAULT_TENANT_ID);
    const approvalStore = new EventBackedApprovalStore(eventStore, 'session-shell-auto', DEFAULT_TENANT_ID);
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
    const eventStore = new FileEventStore(eventPath, DEFAULT_TENANT_ID);
    const authorizeModelTurn = vi.fn(async () => undefined);
    const loop = new RawAgentLoop({
      modelAdapter: new TextThenToolThenTextAdapter(),
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-text-tool-text', DEFAULT_TENANT_ID),
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
        cwd, tenantId: DEFAULT_TENANT_ID,
        channelContext: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
        authorizeModelTurn,
      },
    ));

    expect(authorizeModelTurn).toHaveBeenCalledTimes(2);
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
      'context_usage',
      'done',
    ]);

    const runtimeEvents = await eventStore.list(DEFAULT_TENANT_ID, 'session-text-tool-text');
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

  it('starts another model turn when an interjection arrives during a final text response', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-final-interjection-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const adapter = new InterjectionAfterFinalAdapter();
    let queued: QueuedInterjection[] = [{
      inputId: 'input-final',
      sourceRunId: 'source-final',
      clientMsgId: 'client-final',
      message: { channel: 'web', chatId: 'chat-final', content: '请按新条件修正' },
      prompt: '请按新条件修正',
    }];
    let loadCalls = 0;
    const markApplied = vi.fn(async () => {
      queued = [];
    });
    const trySeal = vi.fn(async () => true);
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-final-interjection', DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new PlatformToolRuntime(),
      runStore: {
        markSteeringInputsApplied: markApplied,
        trySealSteeringInputWindow: trySeal,
      } as unknown as RunStore,
    });

    const events = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-final', content: '先回答' },
        prompt: '先回答',
        instructions: '直接回答。',
        maxTurns: 3,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'target-final',
        sessionId: 'session-final-interjection',
        model: 'gpt-5.5',
        cwd, tenantId: DEFAULT_TENANT_ID,
        channelContext: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
        loadQueuedInterjections: async () => {
          loadCalls += 1;
          return loadCalls === 1 ? [] : queued;
        },
      },
    ));

    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[1]?.messages.slice(-2)).toEqual([
      { role: 'assistant', content: '第一段回答。' },
      { role: 'user', content: '请按新条件修正' },
    ]);
    expect(events.filter((event) => event.type === 'interjection_applied')).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(markApplied).toHaveBeenCalledWith('target-final', ['source-final']);
    expect(trySeal).toHaveBeenCalledTimes(1);
  });

  it('does not start an extra model turn when steering reservation permanently fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-steering-reserve-failure-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const adapter = new InterjectionAfterFinalAdapter();
    const queued: QueuedInterjection[] = [{
      inputId: 'input-reserve-failure',
      sourceRunId: 'source-reserve-failure',
      clientMsgId: 'client-reserve-failure',
      message: { channel: 'web', chatId: 'chat-reserve-failure', content: '不会被重复执行' },
      prompt: '不会被重复执行',
    }];
    let loadCalls = 0;
    const reserve = vi.fn(async () => {
      throw new Error('permanent reserve failure');
    });
    const markApplied = vi.fn(async () => ['source-reserve-failure']);
    const drainHandoff = { requested: false };
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-steering-reserve-failure', DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new PlatformToolRuntime(),
      runStore: {
        reserveSteeringInputs: reserve,
        markSteeringInputsApplied: markApplied,
        trySealSteeringInputWindow: vi.fn(async () => false),
      } as unknown as RunStore,
    });

    const events = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-reserve-failure', content: '先回答' },
        prompt: '先回答',
        instructions: '直接回答。',
        maxTurns: 100,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'target-reserve-failure',
        sessionId: 'session-steering-reserve-failure',
        model: 'gpt-5.5',
        cwd,
        drainHandoff, tenantId: DEFAULT_TENANT_ID,
        channelContext: { channel: 'web' },
        loadQueuedInterjections: async () => {
          loadCalls += 1;
          return loadCalls === 1 ? [] : queued;
        },
      },
    ));

    expect(adapter.requests).toHaveLength(1);
    expect(drainHandoff).toMatchObject({
      requested: true,
      reason: 'steering_reserve_failed',
    });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(markApplied).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === 'interjection_applied')).toBe(false);
    const durableEvents = await eventStore.list(DEFAULT_TENANT_ID, 'session-steering-reserve-failure');
    expect(durableEvents.some((event) => (
      event.type === 'user_message' && event.interjectionSourceRunId === 'source-reserve-failure'
    ))).toBe(false);
    expect(durableEvents.some((event) => event.type === 'run_finished')).toBe(false);
  });

  it('uses atomic steering append/apply and projects the returned durable event exactly once', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-steering-atomic-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const transcriptPath = join(cwd, 'session.jsonl');
    const adapter = new InterjectionAfterFinalAdapter();
    let queued: QueuedInterjection[] = [{
      inputId: 'input-atomic',
      sourceRunId: 'source-atomic',
      clientMsgId: 'client-atomic',
      message: { channel: 'web', chatId: 'chat-atomic', content: '请按原子路径修正' },
      prompt: '请按原子路径修正',
    }];
    let loadCalls = 0;
    const atomicApply = vi.fn(async (_targetRunId: string, inputs: Array<{ sourceRunId: string; event?: any }>) => {
      queued = [];
      const event = inputs[0]!.event!;
      const timestamp = new Date().toISOString();
      return {
        appliedSourceRunIds: ['source-atomic'],
        events: [
          { ...event, id: 'event-atomic', timestamp },
          {
            id: 'event-atomic-applied',
            timestamp,
            type: 'interjection_applied' as const,
            runId: 'target-atomic',
            sessionId: 'session-steering-atomic',
            sourceRunIds: ['source-atomic'],
            clientMsgIds: ['client-atomic'],
          },
        ],
      };
    });
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-steering-atomic', DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime(),
      runStore: {
        reserveSteeringInputs: vi.fn(async (_targetRunId: string, ids: string[]) => ids),
        applySteeringInputsAtomically: atomicApply,
        trySealSteeringInputWindow: vi.fn(async () => true),
      } as unknown as RunStore,
    });

    const outbound = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-atomic', content: '先回答' },
        prompt: '先回答',
        instructions: '直接回答。',
        maxTurns: 100,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'target-atomic',
        sessionId: 'session-steering-atomic',
        model: 'gpt-5.5',
        cwd, tenantId: DEFAULT_TENANT_ID,
        channelContext: { channel: 'web' },
        loadQueuedInterjections: async () => {
          loadCalls += 1;
          return loadCalls === 1 ? [] : queued;
        },
      },
    ));

    expect(atomicApply).toHaveBeenCalledTimes(1);
    const durableEvents = await eventStore.list(DEFAULT_TENANT_ID, 'session-steering-atomic');
    expect(durableEvents.filter((event) => (
      event.type === 'user_message' && event.interjectionSourceRunId === 'source-atomic'
    ))).toHaveLength(0);
    expect(durableEvents.filter((event) => event.type === 'interjection_applied')).toHaveLength(0);
    expect(outbound.filter((event) => event.type === 'interjection_applied')).toEqual([{
      type: 'interjection_applied',
      sourceRunIds: ['source-atomic'],
      clientMsgIds: ['client-atomic'],
    }]);
    const transcript = await readFile(transcriptPath, 'utf-8');
    expect(transcript.split('请按原子路径修正').length - 1).toBe(1);
  });

  it('announces the applied subset before handing off a partial steering apply', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-steering-partial-apply-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const adapter = new InterjectionAfterFinalAdapter();
    const queued: QueuedInterjection[] = [
      {
        inputId: 'input-partial-1',
        sourceRunId: 'source-partial-1',
        clientMsgId: 'client-partial-1',
        message: { channel: 'web', chatId: 'chat-partial-apply', content: '第一条补充' },
        prompt: '第一条补充',
      },
      {
        inputId: 'input-partial-2',
        sourceRunId: 'source-partial-2',
        clientMsgId: 'client-partial-2',
        message: { channel: 'web', chatId: 'chat-partial-apply', content: '第二条补充' },
        prompt: '第二条补充',
      },
    ];
    let loadCalls = 0;
    const drainHandoff = { requested: false };
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-steering-partial-apply', DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new PlatformToolRuntime(),
      runStore: {
        reserveSteeringInputs: vi.fn(async (_targetRunId: string, sourceRunIds: string[]) => sourceRunIds),
        markSteeringInputsApplied: vi.fn(async () => ['source-partial-1']),
        trySealSteeringInputWindow: vi.fn(async () => false),
      } as unknown as RunStore,
    });

    const events = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-partial-apply', content: '先回答' },
        prompt: '先回答',
        instructions: '直接回答。',
        maxTurns: 100,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'target-partial-apply',
        sessionId: 'session-steering-partial-apply',
        model: 'gpt-5.5',
        cwd,
        drainHandoff, tenantId: DEFAULT_TENANT_ID,
        channelContext: { channel: 'web' },
        loadQueuedInterjections: async () => {
          loadCalls += 1;
          return loadCalls === 1 ? [] : queued;
        },
      },
    ));

    expect(adapter.requests).toHaveLength(1);
    expect(drainHandoff).toMatchObject({
      requested: true,
      reason: 'steering_reserved_apply_partial',
    });
    expect(events.filter((event) => event.type === 'interjection_applied')).toEqual([{
      type: 'interjection_applied',
      sourceRunIds: ['source-partial-1'],
      clientMsgIds: ['client-partial-1'],
    }]);
    const durableEvents = await eventStore.list(DEFAULT_TENANT_ID, 'session-steering-partial-apply');
    expect(durableEvents.some((event) => event.type === 'run_finished')).toBe(false);
  });

  it('hands off the target without another model turn when apply fails after reserve', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-steering-apply-failure-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const adapter = new InterjectionAfterFinalAdapter();
    const queued: QueuedInterjection[] = [{
      inputId: 'input-apply-failure',
      sourceRunId: 'source-apply-failure',
      message: { channel: 'web', chatId: 'chat-apply-failure', content: '等待同一目标恢复' },
      prompt: '等待同一目标恢复',
    }];
    let loadCalls = 0;
    const drainHandoff = { requested: false };
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-steering-apply-failure', DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new PlatformToolRuntime(),
      runStore: {
        reserveSteeringInputs: vi.fn(async (_targetRunId: string, sourceRunIds: string[]) => sourceRunIds),
        markSteeringInputsApplied: vi.fn(async () => {
          throw new Error('apply unavailable');
        }),
        trySealSteeringInputWindow: vi.fn(async () => false),
      } as unknown as RunStore,
    });

    await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-apply-failure', content: '先回答' },
        prompt: '先回答',
        instructions: '直接回答。',
        maxTurns: 100,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'target-apply-failure',
        sessionId: 'session-steering-apply-failure',
        model: 'gpt-5.5',
        cwd,
        drainHandoff, tenantId: DEFAULT_TENANT_ID,
        channelContext: { channel: 'web' },
        loadQueuedInterjections: async () => {
          loadCalls += 1;
          return loadCalls === 1 ? [] : queued;
        },
      },
    ));

    expect(adapter.requests).toHaveLength(1);
    expect(drainHandoff).toMatchObject({
      requested: true,
      reason: 'steering_reserved_apply_failed',
    });
    const durableEvents = await eventStore.list(DEFAULT_TENANT_ID, 'session-steering-apply-failure');
    expect(durableEvents).toContainEqual(expect.objectContaining({
      type: 'user_message',
      interjectionSourceRunId: 'source-apply-failure',
    }));
    expect(durableEvents.some((event) => event.type === 'run_finished')).toBe(false);
  });

  it('owns the source before a model request that aborts before its first event', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-interjection-cancel-boundary-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const controller = new AbortController();
    const adapter = new AbortBeforeInterjectionEventAdapter(controller);
    const queued: QueuedInterjection[] = [{
      inputId: 'input-cancel-boundary',
      sourceRunId: 'source-cancel-boundary',
      clientMsgId: 'client-cancel-boundary',
      message: { channel: 'web', chatId: 'chat-cancel-boundary', content: '取消前插话' },
      prompt: '取消前插话',
    }];
    let loadCalls = 0;
    const markApplied = vi.fn(async (_targetRunId: string, sourceRunIds: string[]) => sourceRunIds);
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-interjection-cancel-boundary', DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new PlatformToolRuntime(),
      runStore: {
        markSteeringInputsApplied: markApplied,
        trySealSteeringInputWindow: async () => false,
      } as unknown as RunStore,
    });

    const events = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-cancel-boundary', content: '先回答' },
        prompt: '先回答',
        instructions: '直接回答。',
        maxTurns: 3,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'target-cancel-boundary',
        sessionId: 'session-interjection-cancel-boundary',
        model: 'gpt-5.5',
        cwd,
        signal: controller.signal, tenantId: DEFAULT_TENANT_ID,
        channelContext: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
        loadQueuedInterjections: async () => {
          loadCalls += 1;
          return loadCalls === 1 ? [] : queued;
        },
      },
    ));

    expect(events.at(-1)).toEqual({
      type: 'error',
      error: 'cancelled before interjection model event',
    });
    expect(adapter.calls).toBe(2);
    expect(events).toContainEqual({
      type: 'interjection_applied',
      sourceRunIds: ['source-cancel-boundary'],
      clientMsgIds: ['client-cancel-boundary'],
    });
    expect(markApplied).toHaveBeenCalledWith('target-cancel-boundary', ['source-cancel-boundary']);
  });

  it('owns the source before a model request that fails before producing content', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-interjection-failed-boundary-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const adapter = new FailedBeforeInterjectionEventAdapter();
    const queued: QueuedInterjection[] = [{
      inputId: 'input-failed-boundary',
      sourceRunId: 'source-failed-boundary',
      clientMsgId: 'client-failed-boundary',
      message: { channel: 'web', chatId: 'chat-failed-boundary', content: '失败前插话' },
      prompt: '失败前插话',
    }];
    let loadCalls = 0;
    const markApplied = vi.fn(async (_targetRunId: string, sourceRunIds: string[]) => sourceRunIds);
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-interjection-failed-boundary', DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new PlatformToolRuntime(),
      runStore: {
        markSteeringInputsApplied: markApplied,
        trySealSteeringInputWindow: async () => false,
      } as unknown as RunStore,
    });

    const events = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-failed-boundary', content: '先回答' },
        prompt: '先回答',
        instructions: '直接回答。',
        maxTurns: 3,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'target-failed-boundary',
        sessionId: 'session-interjection-failed-boundary',
        model: 'gpt-5.5',
        cwd, tenantId: DEFAULT_TENANT_ID,
        channelContext: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
        loadQueuedInterjections: async () => {
          loadCalls += 1;
          return loadCalls === 1 ? [] : queued;
        },
      },
    ));

    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: expect.stringContaining('max_output_tokens'),
    });
    expect(adapter.calls).toBe(2);
    expect(events).toContainEqual({
      type: 'interjection_applied',
      sourceRunIds: ['source-failed-boundary'],
      clientMsgIds: ['client-failed-boundary'],
    });
    expect(markApplied).toHaveBeenCalledWith('target-failed-boundary', ['source-failed-boundary']);
  });

  it('keeps interjections pending when the target aborts while loading them', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-aborted-interjection-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const adapter = new InterjectionAfterFinalAdapter();
    const controller = new AbortController();
    const queued: QueuedInterjection[] = [{
      inputId: 'input-aborted',
      sourceRunId: 'source-aborted',
      clientMsgId: 'client-aborted',
      message: { channel: 'web', chatId: 'chat-aborted', content: '取消瞬间的插话' },
      prompt: '取消瞬间的插话',
    }];
    let loadCalls = 0;
    const markApplied = vi.fn(async () => {});
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-aborted-interjection', DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new PlatformToolRuntime(),
      runStore: {
        markSteeringInputsApplied: markApplied,
        trySealSteeringInputWindow: vi.fn(async () => false),
      } as unknown as RunStore,
    });

    const events = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-aborted', content: '先回答' },
        prompt: '先回答',
        instructions: '直接回答。',
        maxTurns: 3,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'target-aborted',
        sessionId: 'session-aborted-interjection',
        model: 'gpt-5.5',
        cwd,
        signal: controller.signal, tenantId: DEFAULT_TENANT_ID,
        channelContext: { channel: 'web' },
        loadQueuedInterjections: async () => {
          loadCalls += 1;
          if (loadCalls === 1) return [];
          controller.abort(new Error('cancelled'));
          return queued;
        },
      },
    ));

    expect(markApplied).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === 'interjection_applied')).toBe(false);
    expect(adapter.requests).toHaveLength(1);
  });

  it('injects all queued interjections after tool completion into one next model turn', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-interjection-'));
    cleanupDirs.add(cwd);
    await writeFile(join(cwd, 'seed.txt'), 'seed content', 'utf-8');
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const adapter = new InterjectionAfterToolAdapter();
    let loadCalls = 0;
    let queued: QueuedInterjection[] = [
      {
        inputId: 'input-1',
        sourceRunId: 'source-run-1',
        clientMsgId: 'client-1',
        message: { channel: 'web', chatId: 'chat-1', content: '补充条件一' },
        prompt: '[2026/08/05 周三 12:50] 补充条件一',
      },
      {
        inputId: 'input-2',
        sourceRunId: 'source-run-2',
        clientMsgId: 'client-2',
        message: { channel: 'web', chatId: 'chat-1', content: '补充条件二' },
        prompt: '[2026/08/05 周三 12:51] 补充条件二',
      },
    ];
    const markApplied = vi.fn(async (_targetRunId: string, _sourceRunIds: string[]) => {
      queued = [];
    });
    const runStore = {
      markSteeringInputsApplied: markApplied,
      trySealSteeringInputWindow: vi.fn(async () => true),
    } as unknown as RunStore;
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-interjection', DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new PlatformToolRuntime(),
      runStore,
    });

    const events = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '先读文件' },
        prompt: '先读文件',
        instructions: '读取后回答。',
        maxTurns: 4,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'target-run',
        sessionId: 'session-interjection',
        model: 'gpt-5.5',
        cwd, tenantId: DEFAULT_TENANT_ID,
        channelContext: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
        loadQueuedInterjections: async () => {
          loadCalls += 1;
          return loadCalls === 1 ? [] : queued;
        },
      },
    ));

    expect(events.map((event) => event.type)).toContain('interjection_applied');
    expect(events.find((event) => event.type === 'interjection_applied')).toMatchObject({
      sourceRunIds: ['source-run-1', 'source-run-2'],
      clientMsgIds: ['client-1', 'client-2'],
    });
    expect(markApplied).toHaveBeenCalledWith('target-run', ['source-run-1', 'source-run-2']);
    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[1]?.messages.filter((message) => message.role === 'user').slice(-2)).toEqual([
      { role: 'user', content: '[2026/08/05 周三 12:50] 补充条件一' },
      { role: 'user', content: '[2026/08/05 周三 12:51] 补充条件二' },
    ]);
    const runtimeEvents = await eventStore.list(DEFAULT_TENANT_ID, 'session-interjection');
    expect(runtimeEvents.filter((event) => event.type === 'user_message')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        content: '补充条件一',
        modelContent: '[2026/08/05 周三 12:50] 补充条件一',
        interjectionSourceRunId: 'source-run-1',
        clientMsgId: 'client-1',
      }),
      expect.objectContaining({
        content: '补充条件二',
        modelContent: '[2026/08/05 周三 12:51] 补充条件二',
        interjectionSourceRunId: 'source-run-2',
        clientMsgId: 'client-2',
      }),
    ]));
  });

  it('streams assistant_tool_calls content when the model only returns it in the completed event', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-static-tool-content-'));
    cleanupDirs.add(cwd);
    await writeFile(join(cwd, 'seed.txt'), 'seed content', 'utf-8');
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const transcriptPath = join(cwd, 'session.jsonl');
    const eventStore = new FileEventStore(eventPath, DEFAULT_TENANT_ID);
    const loop = new RawAgentLoop({
      modelAdapter: new StaticContentToolThenTextAdapter(),
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-static-tool-content', DEFAULT_TENANT_ID),
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
        cwd, tenantId: DEFAULT_TENANT_ID,
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

    const runtimeEvents = await eventStore.list(DEFAULT_TENANT_ID, 'session-static-tool-content');
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
    const eventStore = new FileEventStore(eventPath, DEFAULT_TENANT_ID);
    const onResult = vi.fn();
    const loop = new RawAgentLoop({
      modelAdapter: new EmptyUsageAdapter(),
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-error-usage', DEFAULT_TENANT_ID),
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
        cwd, tenantId: DEFAULT_TENANT_ID,
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

  it('persists partial assistant text when the provider fails after output', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-partial-error-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const loop = new RawAgentLoop({
      modelAdapter: new PartialFailureAdapter(),
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-partial-error', DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new PlatformToolRuntime(),
    });
    const events = await collect(loop.run({
      message: { channel: 'web', chatId: 'chat-1', content: '写一份报告' },
      prompt: '写一份报告',
      instructions: '完成任务。',
      maxTurns: 1,
      connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
    }, {
      runId: 'run-partial-error',
      sessionId: 'session-partial-error',
      model: 'gpt-5.5',
      cwd, tenantId: DEFAULT_TENANT_ID,
      channelContext: { channel: 'web', user: { id: 'admin-1', username: 'admin', role: 'admin' } },
    }));
    expect(events.at(-1)).toMatchObject({ type: 'error', error: expect.stringContaining('可发送“继续”') });
    const persisted = await eventStore.list(DEFAULT_TENANT_ID, 'session-partial-error');
    expect(persisted.find((event) => event.type === 'assistant_message')).toMatchObject({
      content: '已经生成但尚未完成',
      streamed: true,
      incomplete: true,
    });
  });

  it('incomplete 终态即使带 tool call 也不保存 responseId、不落工具调用、不执行工具', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-incomplete-tool-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const patches: ResponseSessionStatePatch[] = [];
    const runStore = {
      findLatestResponseSessionStateBySession: async () => null,
      updateResponseSessionState: async (_runId: string, patch: ResponseSessionStatePatch) => {
        patches.push(patch);
        return null;
      },
    } as unknown as RunStore;
    const loop = new RawAgentLoop({
      modelAdapter: new IncompleteToolCallAdapter(),
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-incomplete-tool', DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new PlatformToolRuntime(),
      runStore,
    });

    const outbound = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '执行' },
        prompt: '执行',
        instructions: '执行。',
        maxTurns: 1,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'run-incomplete-tool',
        sessionId: 'session-incomplete-tool',
        model: 'gpt-5.6-sol',
        cwd, tenantId: DEFAULT_TENANT_ID,
        channelContext: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
      },
    ));

    expect(outbound.at(-1)).toMatchObject({ type: 'error' });
    expect(outbound.at(-1)?.error).toContain('status=incomplete');
    expect(patches).toEqual([]);
    const runtimeEvents = await eventStore.list(DEFAULT_TENANT_ID, 'session-incomplete-tool');
    expect(runtimeEvents.some((event) => event.type === 'assistant_tool_calls')).toBe(false);
    expect(runtimeEvents.some((event) => event.type === 'approval_requested')).toBe(false);
    expect(runtimeEvents.find((event) => event.type === 'run_finished')).toMatchObject({
      subtype: 'error',
      modelUsage: {
        'gpt-5.6-sol': {
          inputTokens: 100,
          outputTokens: 4096,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          apiRequestCount: 1,
        },
      },
    });
    expect(existsSync(join(cwd, 'must-not-exist.txt'))).toBe(false);
  });

  it('模型 attempt 诊断经独立旁路持久化，但不投影到对话 transcript', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-model-diagnostic-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const transcriptPath = join(cwd, 'session.jsonl');
    const loop = new RawAgentLoop({
      modelAdapter: new DiagnosticTextAdapter(),
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-model-diagnostic', DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime(),
    });

    await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '执行' },
        prompt: '执行',
        instructions: '执行。',
        maxTurns: 1,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'run-model-diagnostic',
        sessionId: 'session-model-diagnostic',
        model: 'gpt-5.6-sol',
        cwd, tenantId: DEFAULT_TENANT_ID,
        channelContext: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
      },
    ));

    const runtimeEvents = await eventStore.list(DEFAULT_TENANT_ID, 'session-model-diagnostic');
    expect(runtimeEvents.filter((event) => event.type.startsWith('model_request_')).map((event) => event.type))
      .toEqual(['model_request_started', 'model_request_checkpoint', 'model_request_finished']);
    const transcript = await readFile(transcriptPath, 'utf-8');
    expect(transcript).not.toContain('model-request-persisted');
    expect(transcript).not.toContain('model_request_');
  });

  it('can send a hidden continuation prompt without recording a user_message', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-hidden-continue-'));
    cleanupDirs.add(cwd);
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const transcriptPath = join(cwd, 'session.jsonl');
    const adapter = new FinalTextAdapter();
    const eventStore = new FileEventStore(eventPath, DEFAULT_TENANT_ID);
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-hidden-continue', DEFAULT_TENANT_ID),
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
        cwd, tenantId: DEFAULT_TENANT_ID,
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
    const eventStore = new FileEventStore(eventPath, DEFAULT_TENANT_ID);
    const loop = new RawAgentLoop({
      modelAdapter: new ThinkingTextAdapter(),
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-thinking-1', DEFAULT_TENANT_ID),
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
        cwd, tenantId: DEFAULT_TENANT_ID,
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
      'context_usage',
      'done',
    ]);

    const runtimeEvents = (await eventStore.list(DEFAULT_TENANT_ID, 'session-thinking-1'));
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

  it('replaces a failed Web draft in-place and persists only the successful attempt', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-replaceable-draft-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const transcriptPath = join(cwd, 'session.jsonl');
    const loop = new RawAgentLoop({
      modelAdapter: new ReplaceableDraftAdapter(),
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-replaceable-draft', DEFAULT_TENANT_ID),
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
        runId: 'run-replaceable-draft',
        sessionId: 'session-replaceable-draft',
        model: 'gpt-5.6-sol',
        cwd, tenantId: DEFAULT_TENANT_ID,
        channelContext: {
          channel: 'web',
          replaceableDrafts: true,
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
      },
    ));

    const draftStarts = events.filter((event) => (
      (event.type === 'thinking_start' || event.type === 'text_start') && event.draftId
    ));
    const draftIds = new Set(draftStarts.map((event) => event.draftId));
    expect(draftIds.size).toBe(1);
    const draftId = [...draftIds][0]!;
    expect(events.map((event) => event.type)).toEqual([
      'thinking_start',
      'thinking_delta',
      'thinking_end',
      'text_start',
      'text_delta',
      'draft_reset',
      'thinking_start',
      'thinking_delta',
      'thinking_end',
      'text_start',
      'text_delta',
      'text_end',
      'draft_commit',
      'context_usage',
      'done',
    ]);
    expect(events.find((event) => event.type === 'draft_reset')).toEqual({
      type: 'draft_reset',
      draftId,
      attempt: 1,
    });
    expect(events.find((event) => event.type === 'draft_commit')).toEqual({
      type: 'draft_commit',
      draftId,
    });

    const runtimeEvents = await eventStore.list(DEFAULT_TENANT_ID, 'session-replaceable-draft');
    expect(runtimeEvents.filter((event) => event.type === 'assistant_thinking')).toEqual([
      expect.objectContaining({ content: '成功轮思考', streamed: true }),
    ]);
    expect(runtimeEvents.filter((event) => event.type === 'assistant_message')).toEqual([
      expect.objectContaining({
        content: '最终答案',
        streamed: true,
        modelRequestAttemptCount: 2,
      }),
    ]);
    const transcript = await readFile(transcriptPath, 'utf-8');
    expect(transcript).not.toContain('失败轮');
    expect(transcript).toContain('最终答案');
  });

  it('restores an uncommitted draft from durable run metadata and consumes the single recovery chance', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-restored-draft-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const adapter = new RestartedDraftAdapter();
    let metadata: Record<string, unknown> = {
      replaceableDraftState: {
        draftId: 'draft-before-restart',
        recoveryUsed: false,
        startedAt: new Date(Date.now() - 1_000).toISOString(),
      },
    };
    const metadataPatches: Record<string, unknown>[] = [];
    const runStore = {
      get: async () => ({ metadata }),
      patchMetadata: async (_runId: string, patch: Record<string, unknown>) => {
        metadataPatches.push(patch);
        metadata = { ...metadata, ...patch };
        return { metadata };
      },
      findLatestResponseSessionStateBySession: async () => null,
    } as unknown as RunStore;
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-restored-draft', DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new PlatformToolRuntime(),
      runStore,
    });

    const events = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '执行' },
        prompt: '执行',
        instructions: '正常回答。',
        maxTurns: 1,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'run-restored-draft',
        sessionId: 'session-restored-draft',
        model: 'gpt-5.6-sol',
        cwd, tenantId: DEFAULT_TENANT_ID,
        channelContext: {
          channel: 'web',
          replaceableDrafts: true,
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
      },
    ));

    expect(events[0]).toEqual({ type: 'draft_reset', draftId: 'draft-before-restart' });
    expect(adapter.retryUsed).toEqual([true]);
    expect(metadataPatches).toHaveLength(3);
    expect(metadataPatches[0]).toEqual({ replaceableDraftState: null });
    expect(metadataPatches[1]).toEqual({
      replaceableDraftState: expect.objectContaining({
        recoveryUsed: true,
        draftId: expect.any(String),
      }),
    });
    expect(metadataPatches[2]).toEqual({ replaceableDraftState: null });
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  it('recovers one thinking-only empty turn with a hidden continuation prompt', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-thinking-only-'));
    cleanupDirs.add(cwd);
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const transcriptPath = join(cwd, 'session.jsonl');
    const eventStore = new FileEventStore(eventPath, DEFAULT_TENANT_ID);
    const adapter = new ThinkingOnlyThenTextAdapter();
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-thinking-only', DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime: new PlatformToolRuntime(),
    });

    const events = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '继续' },
        prompt: '继续',
        instructions: '正常回答。',
        maxTurns: 2,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'run-thinking-only',
        sessionId: 'session-thinking-only',
        model: 'glm-5.2',
        cwd, tenantId: DEFAULT_TENANT_ID,
        channelContext: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
      },
    ));

    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(adapter.calls).toBe(2);
    expect(adapter.requests[1]?.messages.at(-1)).toMatchObject({
      role: 'user',
      content: expect.stringContaining('hidden reasoning only'),
    });

    const runtimeEvents = await eventStore.list(DEFAULT_TENANT_ID, 'session-thinking-only');
    expect(runtimeEvents.filter((event) => event.type === 'assistant_thinking')).toHaveLength(1);
    expect(runtimeEvents.filter((event) => event.type === 'assistant_message')).toHaveLength(1);
    expect(runtimeEvents.find((event) => event.type === 'assistant_message')).toMatchObject({
      content: '继续完成',
    });
    expect(runtimeEvents.filter((event) => event.type === 'user_message')).toHaveLength(1);
  });

  it('resumes a pending approval from approval and runtime event logs after runtime rebuild', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-resume-'));
    cleanupDirs.add(cwd);
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const transcriptPath = join(cwd, 'session.jsonl');
    const firstEventStore = new FileEventStore(eventPath, DEFAULT_TENANT_ID);
    const approvalStore = new EventBackedApprovalStore(firstEventStore, 'session-resume-1', DEFAULT_TENANT_ID);
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
          cwd, tenantId: DEFAULT_TENANT_ID,
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
    const rebuiltEventStore = new FileEventStore(eventPath, DEFAULT_TENANT_ID);
    const rebuiltLoop = new RawAgentLoop({
      modelAdapter: finalAdapter,
      eventStore: rebuiltEventStore,
      approvalStore: new EventBackedApprovalStore(rebuiltEventStore, 'session-resume-1', DEFAULT_TENANT_ID),
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
        cwd, tenantId: DEFAULT_TENANT_ID,
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

    expect((await new EventBackedApprovalStore(rebuiltEventStore, 'session-resume-1', DEFAULT_TENANT_ID).get(interactionId))?.status)
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
    const firstEventStore = new FileEventStore(eventPath, DEFAULT_TENANT_ID);
    const approvalStore = new EventBackedApprovalStore(firstEventStore, 'session-resume-batch-1', DEFAULT_TENANT_ID);
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
          cwd, tenantId: DEFAULT_TENANT_ID,
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
    const rebuiltEventStore = new FileEventStore(eventPath, DEFAULT_TENANT_ID);
    const rebuiltLoop = new RawAgentLoop({
      modelAdapter: finalAdapter,
      eventStore: rebuiltEventStore,
      approvalStore: new EventBackedApprovalStore(rebuiltEventStore, 'session-resume-batch-1', DEFAULT_TENANT_ID),
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
        cwd, tenantId: DEFAULT_TENANT_ID,
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
    const firstEventStore = new FileEventStore(eventPath, DEFAULT_TENANT_ID);
    const approvalStore = new EventBackedApprovalStore(firstEventStore, 'session-two-approvals-1', DEFAULT_TENANT_ID);
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
        cwd, tenantId: DEFAULT_TENANT_ID,
        channelContext: {
          channel: 'web',
          sessionOwner: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
      },
    ));

    const firstApproval = (await approvalStore.list('session-two-approvals-1'))[0]!;
    expect(firstApproval).toMatchObject({ status: 'pending', toolCallId: 'call_write_a' });

    const finalAdapter = new FinalTextAdapter();
    const secondEventStore = new FileEventStore(eventPath, DEFAULT_TENANT_ID);
    const secondApprovalStore = new EventBackedApprovalStore(secondEventStore, 'session-two-approvals-1', DEFAULT_TENANT_ID);
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
        cwd, tenantId: DEFAULT_TENANT_ID,
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
        cwd, tenantId: DEFAULT_TENANT_ID,
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
    const eventStore = new FileEventStore(eventPath, DEFAULT_TENANT_ID);
    const approvalStore = new EventBackedApprovalStore(eventStore, 'session-no-hook', DEFAULT_TENANT_ID);
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
        cwd, tenantId: DEFAULT_TENANT_ID,
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

    const runtimeEvents = await eventStore.list(DEFAULT_TENANT_ID, 'session-no-hook');
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
    const firstEventStore = new FileEventStore(eventPath, DEFAULT_TENANT_ID);
    const toolInvocationStore = new InMemoryToolInvocationStore();
    const firstLoop = new RawAgentLoop({
      modelAdapter: new AskUserOnlyAdapter(),
      eventStore: firstEventStore,
      approvalStore: new EventBackedApprovalStore(firstEventStore, 'session-ask-resume-1', DEFAULT_TENANT_ID),
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
          cwd, tenantId: DEFAULT_TENANT_ID,
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
              }, { tenantId: DEFAULT_TENANT_ID });
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
    }, { tenantId: DEFAULT_TENANT_ID });

    const finalAdapter = new FinalTextAdapter();
    const rebuiltEventStore = new FileEventStore(eventPath, DEFAULT_TENANT_ID);
    const rebuiltLoop = new RawAgentLoop({
      modelAdapter: finalAdapter,
      eventStore: rebuiltEventStore,
      approvalStore: new EventBackedApprovalStore(rebuiltEventStore, 'session-ask-resume-1', DEFAULT_TENANT_ID),
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
        cwd, tenantId: DEFAULT_TENANT_ID,
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
    const eventStore = new FileEventStore(eventPath, DEFAULT_TENANT_ID);
    const toolInvocationStore = new InMemoryToolInvocationStore();
    const loop = new RawAgentLoop({
      modelAdapter: new AskUserOnlyAdapter(),
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-ask-no-hook-1', DEFAULT_TENANT_ID),
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
        cwd, tenantId: DEFAULT_TENANT_ID,
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
    const firstEventStore = new FileEventStore(eventPath, DEFAULT_TENANT_ID);
    const toolInvocationStore = new InMemoryToolInvocationStore();
    const firstLoop = new RawAgentLoop({
      modelAdapter: new AskUserAndReadAdapter(),
      eventStore: firstEventStore,
      approvalStore: new EventBackedApprovalStore(firstEventStore, 'session-ask-batch-1', DEFAULT_TENANT_ID),
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
          cwd, tenantId: DEFAULT_TENANT_ID,
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
              }, { tenantId: DEFAULT_TENANT_ID });
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
    }, { tenantId: DEFAULT_TENANT_ID });

    const finalAdapter = new FinalTextAdapter();
    const rebuiltEventStore = new FileEventStore(eventPath, DEFAULT_TENANT_ID);
    const rebuiltLoop = new RawAgentLoop({
      modelAdapter: finalAdapter,
      eventStore: rebuiltEventStore,
      approvalStore: new EventBackedApprovalStore(rebuiltEventStore, 'session-ask-batch-1', DEFAULT_TENANT_ID),
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
        cwd, tenantId: DEFAULT_TENANT_ID,
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
    const eventStore = new FileEventStore(eventPath, DEFAULT_TENANT_ID);
    const toolInvocationStore = new InMemoryToolInvocationStore();
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-audit-error', DEFAULT_TENANT_ID),
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
        executionTarget: 'server-container', tenantId: DEFAULT_TENANT_ID,
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

  it('does not execute a tool inserted after its run already became cancelled', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-cancelled-late-tool-'));
    cleanupDirs.add(cwd);
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const transcriptPath = join(cwd, 'session.jsonl');
    const eventStore = new FileEventStore(eventPath, DEFAULT_TENANT_ID);
    const toolInvocationStore = new InMemoryToolInvocationStore();
    const toolRuntime = new CountingToolRuntime();
    const runStore = {
      get: vi.fn(async () => ({
        runId: 'run-cancelled-late-tool',
        sessionId: 'session-cancelled-late-tool',
        status: 'cancelled',
        requestedAt: '2026-08-15T00:00:00.000Z',
        updatedAt: '2026-08-15T00:00:01.000Z',
        metadata: {},
      })),
    } as unknown as RunStore;
    const loop = new RawAgentLoop({
      modelAdapter: new FakeToolCallingAdapter(),
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-cancelled-late-tool', DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(transcriptPath),
      toolRuntime,
      toolInvocationStore,
      runStore,
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
        runId: 'run-cancelled-late-tool',
        sessionId: 'session-cancelled-late-tool',
        model: 'gpt-5.5',
        cwd, tenantId: DEFAULT_TENANT_ID,
        channelContext: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
        hooks: { onInteraction: async () => ({ allow: true, message: 'ok' }) },
      },
    ));

    expect(toolRuntime.invocations).toBe(0);
    await expect(toolInvocationStore.get('run-cancelled-late-tool:call_write_1')).resolves.toMatchObject({
      status: 'cancelled',
      cancelRequestedAt: expect.any(String),
      cancelReason: 'run_already_cancelled_before_tool_start',
    });
    expect(events.map((event) => event.type)).toContain('done');
    await expect(eventStore.list(DEFAULT_TENANT_ID, 'session-cancelled-late-tool')).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_invocation_cancel_requested' }),
      expect.objectContaining({ type: 'tool_invocation_completed', status: 'cancelled' }),
    ]));
  });

  it('rechecks the authoritative run inside the final invoke gate and closes the get-to-invoke race', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-terminal-between-get-invoke-'));
    cleanupDirs.add(cwd);
    const sessionId = 'session-terminal-between-get-invoke';
    const runId = 'run-terminal-between-get-invoke';
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const toolInvocationStore = new InMemoryToolInvocationStore();
    const toolRuntime = new CountingToolRuntime();
    let reads = 0;
    const getRun = vi.fn(async () => ({
      runId,
      sessionId,
      status: ++reads === 1 ? 'running' : 'completed',
      requestedAt: '2026-08-15T00:00:00.000Z',
      updatedAt: '2026-08-15T00:00:01.000Z',
      metadata: {},
    }));
    const runStore = { get: getRun } as unknown as RunStore;
    const loop = new RawAgentLoop({
      modelAdapter: new FakeToolCallingAdapter(),
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, sessionId, DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime,
      toolInvocationStore,
      runStore,
    });

    await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '写文件' },
        prompt: '写文件',
        instructions: '必须调用工具。',
        maxTurns: 4,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId,
        sessionId,
        model: 'gpt-5.5',
        cwd, tenantId: DEFAULT_TENANT_ID,
        channelContext: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
        hooks: { onInteraction: async () => ({ allow: true, message: 'ok' }) },
      },
    ));

    expect(getRun.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(toolRuntime.invocations).toBe(0);
    await expect(toolInvocationStore.get(`${runId}:call_write_1`)).resolves.toMatchObject({
      status: 'failed',
      error: `tool invocation blocked because run is already terminal status=completed: ${runId}:call_write_1`,
    });
  });

  it('duplicate worker losing invocation claim exits without failing the winner run or replaying tool lifecycle', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-duplicate-claim-loser-'));
    cleanupDirs.add(cwd);
    const sessionId = 'session-duplicate-claim-loser';
    const runId = 'run-duplicate-claim-loser';
    const invocationId = `${runId}:call_write_1`;
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const toolInvocationStore = new InMemoryToolInvocationStore();
    await toolInvocationStore.start({
      invocationId,
      runId,
      sessionId,
      toolCallId: 'call_write_1',
      toolName: 'Write',
      executionTarget: 'server-local',
    });
    await toolInvocationStore.invokeWithActiveRunGate(
      runId, invocationId, async () => 'winner-started', async () => 'running',
    );
    const toolRuntime = new CountingToolRuntime();
    const loop = new RawAgentLoop({
      modelAdapter: new FakeToolCallingAdapter(),
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, sessionId, DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime,
      toolInvocationStore,
      runStore: { get: vi.fn(async () => ({ status: 'running' })) } as unknown as RunStore,
    });

    const outbound = await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '写文件' },
        prompt: '写文件',
        instructions: '必须调用工具。',
        maxTurns: 4,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId,
        sessionId,
        model: 'gpt-5.5',
        cwd, tenantId: DEFAULT_TENANT_ID,
        channelContext: { channel: 'web', user: { id: 'admin-1', username: 'admin', role: 'admin' } },
        hooks: { onInteraction: async () => ({ allow: true, message: 'ok' }) },
      },
    ));

    expect(toolRuntime.invocations).toBe(0);
    expect(outbound.some((event) => event.type === 'error')).toBe(false);
    await expect(toolInvocationStore.get(invocationId)).resolves.toMatchObject({ status: 'running' });
    const lifecycle = await eventStore.list(DEFAULT_TENANT_ID, sessionId);
    expect(lifecycle.some((event) => event.type === 'tool_invocation_started')).toBe(false);
    expect(lifecycle.some((event) => event.type === 'tool_invocation_completed')).toBe(false);
    expect(lifecycle.some((event) => event.type === 'run_finished' && event.subtype === 'error')).toBe(false);
  });

  it.each(['completed', 'failed', 'orphaned'] as const)(
    'does not execute a tool after its authoritative run became %s',
    async (terminalStatus) => {
      const cwd = await mkdtemp(join(tmpdir(), `raw-loop-${terminalStatus}-late-tool-`));
      cleanupDirs.add(cwd);
      const sessionId = `session-${terminalStatus}-late-tool`;
      const runId = `run-${terminalStatus}-late-tool`;
      const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
      const toolInvocationStore = new InMemoryToolInvocationStore();
      const toolRuntime = new CountingToolRuntime();
      const runStore = {
        get: vi.fn(async () => ({
          runId,
          sessionId,
          status: terminalStatus,
          requestedAt: '2026-08-15T00:00:00.000Z',
          updatedAt: '2026-08-15T00:00:01.000Z',
          metadata: {},
        })),
      } as unknown as RunStore;
      const loop = new RawAgentLoop({
        modelAdapter: new FakeToolCallingAdapter(),
        eventStore,
        approvalStore: new EventBackedApprovalStore(eventStore, sessionId, DEFAULT_TENANT_ID),
        transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
        toolRuntime,
        toolInvocationStore,
        runStore,
      });

      await collect(loop.run(
        {
          message: { channel: 'web', chatId: 'chat-1', content: '写文件' },
          prompt: '写文件',
          instructions: '必须调用工具。',
          maxTurns: 4,
          connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
        },
        {
          runId,
          sessionId,
          model: 'gpt-5.5',
          cwd, tenantId: DEFAULT_TENANT_ID,
          channelContext: {
            channel: 'web',
            user: { id: 'admin-1', username: 'admin', role: 'admin' },
          },
          hooks: { onInteraction: async () => ({ allow: true, message: 'ok' }) },
        },
      ));

      expect(toolRuntime.invocations).toBe(0);
      await expect(toolInvocationStore.get(`${runId}:call_write_1`)).resolves.toMatchObject({
        status: 'failed',
        error: `tool invocation blocked because run is already terminal status=${terminalStatus}: ${runId}:call_write_1`,
      });
      expect((await toolInvocationStore.get(`${runId}:call_write_1`))?.cancelRequestedAt).toBeUndefined();
      const events = await eventStore.list(DEFAULT_TENANT_ID, sessionId);
      expect(events.some((event) => event.type === 'tool_invocation_cancel_requested')).toBe(false);
    },
  );

  it('does not replay lifecycle events or side effects for an already-terminal invocation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-terminal-invocation-replay-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const toolInvocationStore = new InMemoryToolInvocationStore();
    await toolInvocationStore.start({
      invocationId: 'run-terminal-replay:call_write_1',
      runId: 'run-terminal-replay',
      sessionId: 'session-terminal-replay',
      toolCallId: 'call_write_1',
      toolName: 'Write',
      executionTarget: 'server-local',
    });
    await toolInvocationStore.complete('run-terminal-replay:call_write_1', 'completed');
    const toolRuntime = new CountingToolRuntime();
    const loop = new RawAgentLoop({
      modelAdapter: new FakeToolCallingAdapter(),
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-terminal-replay', DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime,
      toolInvocationStore,
      runStore: { get: vi.fn(async () => ({ status: 'running' })) } as unknown as RunStore,
    });

    await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-1', content: '写文件' },
        prompt: '写文件',
        instructions: '必须调用工具。',
        maxTurns: 4,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'run-terminal-replay',
        sessionId: 'session-terminal-replay',
        model: 'gpt-5.5',
        cwd, tenantId: DEFAULT_TENANT_ID,
        channelContext: { channel: 'web', user: { id: 'admin-1', username: 'admin', role: 'admin' } },
        hooks: { onInteraction: async () => ({ allow: true, message: 'ok' }) },
      },
    ));

    expect(toolRuntime.invocations).toBe(0);
    const events = await eventStore.list(DEFAULT_TENANT_ID, 'session-terminal-replay');
    expect(events.some((event) => event.type === 'tool_invocation_started')).toBe(false);
    expect(events.some((event) => event.type === 'tool_invocation_completed')).toBe(false);
  });

  it('fails closed before tool execution when authoritative run lookup fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-run-lookup-failure-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const toolInvocationStore = new InMemoryToolInvocationStore();
    const toolRuntime = new CountingToolRuntime();
    const loop = new RawAgentLoop({
      modelAdapter: new FakeToolCallingAdapter(),
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-run-lookup-failure', DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime,
      toolInvocationStore,
      runStore: { get: vi.fn(async () => { throw new Error('run store unavailable'); }) } as unknown as RunStore,
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
        runId: 'run-lookup-failure',
        sessionId: 'session-run-lookup-failure',
        model: 'gpt-5.5',
        cwd, tenantId: DEFAULT_TENANT_ID,
        channelContext: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
        hooks: { onInteraction: async () => ({ allow: true, message: 'ok' }) },
      },
    ));

    expect(toolRuntime.invocations).toBe(0);
    await expect(toolInvocationStore.get('run-lookup-failure:call_write_1')).resolves.toMatchObject({
      status: 'failed',
      error: 'run store unavailable',
    });
    expect(events.map((event) => event.type)).toContain('done');
  });

  it('fails closed before tool execution when the authoritative run is missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-run-missing-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const toolInvocationStore = new InMemoryToolInvocationStore();
    const toolRuntime = new CountingToolRuntime();
    const loop = new RawAgentLoop({
      modelAdapter: new FakeToolCallingAdapter(),
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-run-missing', DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime,
      toolInvocationStore,
      runStore: { get: vi.fn(async () => null) } as unknown as RunStore,
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
        runId: 'run-missing',
        sessionId: 'session-run-missing',
        model: 'gpt-5.5',
        cwd, tenantId: DEFAULT_TENANT_ID,
        channelContext: {
          channel: 'web',
          user: { id: 'admin-1', username: 'admin', role: 'admin' },
        },
        hooks: { onInteraction: async () => ({ allow: true, message: 'ok' }) },
      },
    ));

    expect(toolRuntime.invocations).toBe(0);
    await expect(toolInvocationStore.get('run-missing:call_write_1')).resolves.toMatchObject({
      status: 'failed',
      error: 'authoritative run not found: run-missing',
    });
    expect(events.map((event) => event.type)).toContain('done');
  });

  it('blocks a new run when prior event log has an unclosed pending tool call', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-pending-block-'));
    cleanupDirs.add(cwd);
    const eventPath = join(cwd, 'session.runtime-events.jsonl');
    const transcriptPath = join(cwd, 'session.jsonl');
    const firstEventStore = new FileEventStore(eventPath, DEFAULT_TENANT_ID);
    const approvalStore = new EventBackedApprovalStore(firstEventStore, 'session-pending-1', DEFAULT_TENANT_ID);
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
          cwd, tenantId: DEFAULT_TENANT_ID,
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
    const secondEventStore = new FileEventStore(eventPath, DEFAULT_TENANT_ID);
    const secondLoop = new RawAgentLoop({
      modelAdapter: finalAdapter,
      eventStore: secondEventStore,
      approvalStore: new EventBackedApprovalStore(secondEventStore, 'session-pending-1', DEFAULT_TENANT_ID),
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
        cwd, tenantId: DEFAULT_TENANT_ID,
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
    const eventStore = new FileEventStore(eventPath, DEFAULT_TENANT_ID);
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
    }, { tenantId: DEFAULT_TENANT_ID });

    const adapter = new FinalTextAdapter();
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-orphan-1', DEFAULT_TENANT_ID),
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
        cwd, tenantId: DEFAULT_TENANT_ID,
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
    const eventStore = new FileEventStore(eventPath, DEFAULT_TENANT_ID);
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
    }, { tenantId: DEFAULT_TENANT_ID });
    await eventStore.append({
      type: 'tool_invocation_started',
      runId: 'run-running-1',
      sessionId: 'session-running-1',
      invocationId: 'inv-running-1',
      toolCallId: 'call_running_1',
      toolName: 'Shell',
      executionTarget: 'server-local',
    }, { tenantId: DEFAULT_TENANT_ID });

    const adapter = new FinalTextAdapter();
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-running-1', DEFAULT_TENANT_ID),
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
        cwd, tenantId: DEFAULT_TENANT_ID,
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
    const eventStore = new FileEventStore(eventPath, DEFAULT_TENANT_ID);
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
    }, { tenantId: DEFAULT_TENANT_ID });
    await eventStore.append({
      type: 'tool_invocation_started',
      runId: 'run-zombie-1',
      sessionId: 'session-zombie-1',
      invocationId: 'inv-zombie-1',
      toolCallId: 'call_zombie_1',
      toolName: 'Shell',
      executionTarget: 'server-local',
    }, { tenantId: DEFAULT_TENANT_ID });

    const adapter = new FinalTextAdapter();
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-zombie-1', DEFAULT_TENANT_ID),
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
        cwd, tenantId: DEFAULT_TENANT_ID,
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
    const eventStore = new FileEventStore(eventPath, DEFAULT_TENANT_ID);
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
    }, { tenantId: DEFAULT_TENANT_ID });
    await eventStore.append({
      type: 'tool_invocation_started',
      runId: 'run-fresh-1',
      sessionId: 'session-fresh-1',
      invocationId: 'inv-fresh-1',
      toolCallId: 'call_fresh_1',
      toolName: 'Shell',
      executionTarget: 'server-local',
    }, { tenantId: DEFAULT_TENANT_ID });

    const adapter = new FinalTextAdapter();
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-fresh-1', DEFAULT_TENANT_ID),
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
        cwd, tenantId: DEFAULT_TENANT_ID,
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
    priorContextTokens?: number,
    priorModel = currentModel,
  ): Promise<{ adapter: ResponseIdTextAdapter; patches: Array<{ runId: string; patch: ResponseSessionStatePatch }> }> {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-relay-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    if (priorContextTokens) {
      await eventStore.append({
        type: 'assistant_message',
        runId: 'run-relay-1',
        sessionId: 'session-relay-1',
        content: 'prior response',
        model: priorModel,
        usage: { inputTokens: priorContextTokens, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        responseMode: 'full',
        responseChained: false,
      }, { tenantId: DEFAULT_TENANT_ID });
    }
    const adapter = new ResponseIdTextAdapter('resp_new_run');
    const { runStore, patches } = relayFixtures(state);
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-relay-1', DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new PlatformToolRuntime({
        providers: [new SessionToolProvider(new SessionContextService(eventStore, DEFAULT_TENANT_ID))],
      }),
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
        cwd, tenantId: DEFAULT_TENANT_ID,
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

  it('切换模型后不把旧模型上下文账本套进新模型阈值', async () => {
    configureModelPricing({
      groups: [{
        models: [{ value: 'gpt-small', context_window: 1_000, auto_compact_threshold: 0.5 }],
      }],
    });
    try {
      const { adapter } = await runRelayScenario(
        { runId: 'run-relay-1', lastResponseId: 'resp_prev', lastResponseModel: 'glm-5.2' },
        'gpt-small',
        600,
        'glm-5.2',
      );
      expect(adapter.requests[0]?.previousResponseId).toBeUndefined();
      expect(JSON.stringify(adapter.requests[0]?.messages)).not.toContain('平台收束指令');
    } finally {
      configureModelPricing(undefined);
    }
  });

  it('软阈值 checkpoint 不可用时继续正常接力，不提前收束或限制工具', async () => {
    configureModelPricing({
      groups: [{ models: [{ value: 'relay-small', context_window: 1_000, auto_compact_threshold: 0.5 }] }],
    });
    try {
      const { adapter } = await runRelayScenario(
        { runId: 'run-relay-1', lastResponseId: 'resp_prev', lastResponseModel: 'relay-small' },
        'relay-small',
        600,
      );
      expect(adapter.requests[0]?.previousResponseId).toBe('resp_prev');
      expect(adapter.requests[0]?.toolChoice).toBeUndefined();
      expect(adapter.requests[0]?.tools.map((tool) => tool.name)).toContain('SessionContext');
      expect(JSON.stringify(adapter.requests[0]?.messages)).not.toContain('平台收束指令');
      expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('prior response');
    } finally {
      configureModelPricing(undefined);
    }
  });

  it('checkpoint 不可用且达到 95% 硬阈值时才进入紧急收束', async () => {
    configureModelPricing({
      groups: [{ models: [{ value: 'relay-hard', context_window: 1_000, auto_compact_threshold: 0.5 }] }],
    });
    try {
      const { adapter } = await runRelayScenario(
        { runId: 'run-relay-1', lastResponseId: 'resp_prev', lastResponseModel: 'relay-hard' },
        'relay-hard',
        960,
      );
      expect(adapter.requests[0]?.previousResponseId).toBeUndefined();
      expect(adapter.requests[0]?.tools.map((tool) => tool.name)).toEqual(['SessionContext']);
      expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('平台收束指令');
    } finally {
      configureModelPricing(undefined);
    }
  });

  it('context governor 压力先持久化，再传入自动 checkpoint 判定', async () => {
    configureModelPricing({
      groups: [{ models: [{ value: 'pressure-small', context_window: 1_000, auto_compact_threshold: 0.5 }] }],
    });
    try {
      const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-context-pressure-'));
      cleanupDirs.add(cwd);
      const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
      await eventStore.append({
        type: 'assistant_message',
        runId: 'run-pressure-old',
        sessionId: 'session-pressure',
        content: '很长的既有上下文',
        model: 'pressure-small',
        usage: { inputTokens: 600, outputTokens: 1 },
        responseMode: 'full',
        responseChained: false,
      }, { tenantId: DEFAULT_TENANT_ID });
      const patchMetadata = vi.fn(async () => null);
      const runStore = {
        get: vi.fn(async () => ({ status: 'running', metadata: {} })),
        patchMetadata,
        findLatestResponseSessionStateBySession: vi.fn(async () => null),
        updateResponseSessionState: vi.fn(async () => null),
      } as unknown as RunStore;
      const adapter = new ResponseIdTextAdapter('resp-pressure');
      const loop = new RawAgentLoop({
        modelAdapter: adapter,
        eventStore,
        approvalStore: new EventBackedApprovalStore(eventStore, 'session-pressure', DEFAULT_TENANT_ID),
        transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
        toolRuntime: new PlatformToolRuntime(),
        runStore,
      });
      const forceReasons: Array<string | undefined> = [];
      await collect(loop.run(
        {
          message: { channel: 'web', chatId: 'chat-pressure', content: '继续' },
          prompt: '继续',
          instructions: '继续。',
          maxTurns: 1,
          connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
        },
        {
          runId: 'run-pressure',
          sessionId: 'session-pressure',
          model: 'pressure-small',
          cwd, tenantId: DEFAULT_TENANT_ID,
          channelContext: { channel: 'web' },
          evaluateAutoCompaction: (_events, forceReason) => {
            forceReasons.push(forceReason);
            return { shouldCompact: false, reason: 'test_observe_only' };
          },
        },
      ));

      expect(patchMetadata).toHaveBeenCalledWith('run-pressure', {
        contextPressure: expect.objectContaining({
          reason: 'context_governor',
          triggerTokens: 601,
          thresholdTokens: 500,
        }),
      });
      expect(forceReasons).toEqual(['context_governor']);
    } finally {
      configureModelPricing(undefined);
    }
  });

  it('达到阈值时先建立 checkpoint，再以完整业务工具继续同一 run', async () => {
    configureModelPricing({
      groups: [{ models: [{ value: 'checkpoint-small', context_window: 16_000, auto_compact_threshold: 0.5 }] }],
    });
    try {
      const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-pre-request-checkpoint-'));
      cleanupDirs.add(cwd);
      const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
      await eventStore.append({
        type: 'user_message',
        runId: 'run-old',
        sessionId: 'session-checkpoint',
        content: '先前任务',
      }, { tenantId: DEFAULT_TENANT_ID });
      await eventStore.append({
        type: 'assistant_message',
        runId: 'run-old',
        sessionId: 'session-checkpoint',
        content: `先前进度${'历史上下文'.repeat(5_000)}`,
        model: 'checkpoint-small',
        usage: { inputTokens: 10_000, outputTokens: 1 },
        responseMode: 'full',
        responseChained: false,
      }, { tenantId: DEFAULT_TENANT_ID });
      class CheckpointThenContinueAdapter implements ModelAdapter {
        requests: ModelRequest[] = [];
        async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
          this.requests.push(request);
          const isCheckpoint = String(request.messages.at(-1)?.content).includes('上下文压缩');
          const content = isCheckpoint ? '## 检查点\n当前任务尚未完成，下一步继续执行。' : '任务已自动续跑并完成。';
          yield { type: 'text_delta', content };
          yield {
            type: 'completed',
            content,
            toolCalls: [],
            usage: { inputTokens: 100, outputTokens: 10 },
          };
        }
      }
      const adapter = new CheckpointThenContinueAdapter();
      const patchMetadata = vi.fn(async () => null);
      const loop = new RawAgentLoop({
        modelAdapter: adapter,
        eventStore,
        approvalStore: new EventBackedApprovalStore(eventStore, 'session-checkpoint', DEFAULT_TENANT_ID),
        transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
        toolRuntime: new PlatformToolRuntime(),
        runStore: {
          get: vi.fn(async () => ({ status: 'running', metadata: {} })),
          patchMetadata,
          clearResponseSessionStateBySession: vi.fn(async () => 0),
          findLatestResponseSessionStateBySession: vi.fn(async () => null),
        } as unknown as RunStore,
      });
      let evaluations = 0;
      const outbound = await collect(loop.run(
        {
          message: { channel: 'web', chatId: 'chat-checkpoint', content: '继续当前任务' },
          prompt: '继续当前任务',
          instructions: '正常系统指令',
          maxTurns: 1,
          connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
        },
        {
          runId: 'run-checkpoint',
          sessionId: 'session-checkpoint',
          model: 'checkpoint-small',
          cwd, tenantId: DEFAULT_TENANT_ID,
          channelContext: { channel: 'web' },
          evaluateAutoCompaction: () => ({
            shouldCompact: evaluations++ === 0,
            reason: 'context_governor',
          }),
        },
      ));

      expect(adapter.requests).toHaveLength(2);
      const continued = adapter.requests[1]!;
      expect(continued.toolChoice).toBeUndefined();
      expect(continued.tools.length).toBeGreaterThan(0);
      expect(JSON.stringify(continued.messages)).toContain('<context-checkpoint');
      expect(JSON.stringify(continued.messages)).toContain('state=\\"active\\"');
      expect(JSON.stringify(continued.messages)).not.toContain('[平台收束指令]');
      expect(outbound.map((event) => event.type)).toContain('compaction_start');
      expect(outbound.map((event) => event.type)).toContain('compaction_end');
      const events = await eventStore.list(DEFAULT_TENANT_ID, 'session-checkpoint');
      expect(events.filter((event) => event.type === 'run_finished')).toHaveLength(1);
      expect(events.filter((event) => (
        event.type === 'assistant_message' && event.runId === 'run-checkpoint'
      ))).toEqual([expect.objectContaining({ content: '任务已自动续跑并完成。' })]);
      expect(events.find((event) => event.type === 'compaction')).toMatchObject({
        checkpoint: { version: 1, trigger: 'threshold', sourceRunId: 'run-checkpoint' },
      });
    } finally {
      configureModelPricing(undefined);
    }
  });

  it('运行中的 /compact 作为控制信号在安全边界压缩，不进入模型业务消息', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-manual-checkpoint-interjection-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    for (let i = 1; i <= 2; i++) {
      await eventStore.append({
        type: 'user_message',
        runId: `run-old-${i}`,
        sessionId: 'session-manual-control',
        content: `历史问题 ${i}`,
      }, { tenantId: DEFAULT_TENANT_ID });
      await eventStore.append({
        type: 'assistant_message',
        runId: `run-old-${i}`,
        sessionId: 'session-manual-control',
        content: `历史回答 ${i}`,
      }, { tenantId: DEFAULT_TENANT_ID });
    }
    let queued: QueuedInterjection[] = [{
      inputId: 'input-compact',
      sourceRunId: 'source-compact',
      message: { channel: 'web', chatId: 'chat-manual-control', content: '/compact' },
      prompt: '/compact',
    }];
    class ManualCheckpointAdapter implements ModelAdapter {
      requests: ModelRequest[] = [];
      async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
        this.requests.push(request);
        const isCheckpoint = String(request.messages.at(-1)?.content).includes('上下文压缩');
        const content = isCheckpoint ? '手动检查点摘要。' : '原任务继续完成。';
        yield { type: 'text_delta', content };
        yield { type: 'completed', content, toolCalls: [] };
      }
    }
    const adapter = new ManualCheckpointAdapter();
    const ownershipTransitions: string[] = [];
    const reserve = vi.fn(async (_runId: string, sourceRunIds: string[]) => {
      ownershipTransitions.push('reserved');
      return sourceRunIds;
    });
    const markApplied = vi.fn(async (_runId: string, sourceRunIds: string[]) => {
      ownershipTransitions.push('applied');
      queued = [];
      return sourceRunIds;
    });
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-manual-control', DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new PlatformToolRuntime(),
      runStore: {
        get: vi.fn(async () => ({ status: 'running', metadata: {} })),
        patchMetadata: vi.fn(async () => null),
        reserveSteeringInputs: reserve,
        markSteeringInputsApplied: markApplied,
        trySealSteeringInputWindow: vi.fn(async () => true),
        clearResponseSessionStateBySession: vi.fn(async () => 0),
        findLatestResponseSessionStateBySession: vi.fn(async () => null),
      } as unknown as RunStore,
    });
    await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-manual-control', content: '完成原任务' },
        prompt: '完成原任务',
        instructions: '正常系统指令',
        maxTurns: 1,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'run-manual-control',
        sessionId: 'session-manual-control',
        model: 'unconfigured-model',
        cwd, tenantId: DEFAULT_TENANT_ID,
        channelContext: { channel: 'web' },
        loadQueuedInterjections: async () => queued,
      },
    ));

    expect(adapter.requests).toHaveLength(2);
    expect(ownershipTransitions).toEqual(['reserved', 'applied']);
    expect(reserve).toHaveBeenCalledWith('run-manual-control', ['source-compact']);
    expect(JSON.stringify(adapter.requests[1]?.messages)).not.toContain('/compact');
    expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('完成原任务');
    expect(markApplied).toHaveBeenCalledWith('run-manual-control', ['source-compact']);
    const events = await eventStore.list(DEFAULT_TENANT_ID, 'session-manual-control');
    expect(events.find((event) => event.type === 'compaction')).toMatchObject({
      checkpoint: {
        trigger: 'manual',
        sourceRunId: 'run-manual-control',
        controlSourceRunIds: ['source-compact'],
      },
    });
    expect(events.some((event) => event.type === 'user_message' && event.content === '/compact')).toBe(false);
  });

  it('崩溃恢复时复用 active checkpoint 自动续跑，不重复压缩或重复追加用户消息', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-checkpoint-recovery-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const userEvent = await eventStore.append({
      type: 'user_message',
      runId: 'run-recover',
      sessionId: 'session-recover',
      content: '继续修复故障',
    }, { tenantId: DEFAULT_TENANT_ID });
    await eventStore.append({
      type: 'assistant_message',
      runId: 'run-recover',
      sessionId: 'session-recover',
      content: '已经定位根因，尚未完成修复。',
    }, { tenantId: DEFAULT_TENANT_ID });
    await eventStore.append({
      type: 'compaction',
      runId: 'run-recover',
      sessionId: 'session-recover',
      summary: '已经定位根因，下一步修改代码并验证。',
      coveredEventCount: 2,
      inline: true,
      checkpoint: {
        version: 1,
        trigger: 'threshold',
        sourceRunId: 'run-recover',
        targetTokens: 40_000,
        summaryBudgetTokens: 8_000,
        summaryObservedTokens: 100,
        rawTailBudgetTokens: 20_000,
        rawTailObservedTokens: 0,
        fixedTokens: 10_000,
        taskAnchors: [{
          eventId: userEvent.id,
          timestamp: userEvent.timestamp,
          text: '继续修复故障',
          originalChars: 6,
        }],
      },
    }, { tenantId: DEFAULT_TENANT_ID });
    class RecoveryAdapter implements ModelAdapter {
      requests: ModelRequest[] = [];
      async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
        this.requests.push(request);
        yield { type: 'text_delta', content: '已恢复并完成修复。' };
        yield { type: 'completed', content: '已恢复并完成修复。', toolCalls: [] };
      }
    }
    const adapter = new RecoveryAdapter();
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-recover', DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new PlatformToolRuntime(),
      runStore: {
        get: vi.fn(async () => ({ status: 'running', metadata: { contextPressure: { reason: 'context_governor', detectedAt: '2026-08-07T05:00:00.000Z', triggerTokens: 900, thresholdTokens: 800, droppedMessages: 0 } } })),
        patchMetadata: vi.fn(async () => null),
        findLatestResponseSessionStateBySession: vi.fn(async () => null),
      } as unknown as RunStore,
    });
    await collect(loop.run(
      {
        message: { channel: 'web', chatId: 'chat-recover', content: '继续修复故障' },
        prompt: '继续修复故障',
        recordUserMessage: false,
        instructions: '正常系统指令',
        maxTurns: 1,
        connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
      },
      {
        runId: 'run-recover',
        sessionId: 'session-recover',
        model: 'unconfigured-model',
        cwd, tenantId: DEFAULT_TENANT_ID,
        channelContext: { channel: 'web' },
      },
    ));

    expect(adapter.requests).toHaveLength(1);
    const serialized = JSON.stringify(adapter.requests[0]?.messages);
    expect(serialized).toContain('state=\\"active\\"');
    expect(serialized.match(/继续修复故障/g)).toHaveLength(1);
    const events = await eventStore.list(DEFAULT_TENANT_ID, 'session-recover');
    expect(events.filter((event) => event.type === 'compaction')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'user_message')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'run_finished')).toHaveLength(1);
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

  it('local repaired call invalidates stale provider response state before the next turn', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-repair-reset-'));
    cleanupDirs.add(cwd);
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const requests: ModelRequest[] = [];
    const clearedSessions: string[] = [];
    const adapter: ModelAdapter = {
      async *stream(request): AsyncIterable<ModelEvent> {
        requests.push(request);
        yield {
          type: 'completed',
          content: 'ok',
          toolCalls: [],
          responseStateReset: true,
          responseChained: true,
          responseMode: 'relay',
        };
      },
    };
    const runStore = {
      findLatestResponseSessionStateBySession: async () => ({
        runId: 'run-relay-old',
        lastResponseId: 'resp_stale',
        lastResponseModel: 'glm-5.2',
      }),
      clearResponseSessionStateBySession: async (sessionId: string) => {
        clearedSessions.push(sessionId);
        return 1;
      },
    } as unknown as RunStore;
    const loop = new RawAgentLoop({
      modelAdapter: adapter,
      eventStore,
      approvalStore: new EventBackedApprovalStore(eventStore, 'session-repair-reset', DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
      toolRuntime: new PlatformToolRuntime(),
      runStore,
    });

    await collect(loop.run({
      message: { channel: 'web', chatId: 'chat-1', content: 'go' },
      prompt: 'go',
      instructions: 'continue',
      maxTurns: 1,
      connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
    }, {
      runId: 'run-repair-reset',
      sessionId: 'session-repair-reset',
      model: 'glm-5.2',
      cwd, tenantId: DEFAULT_TENANT_ID,
      channelContext: { channel: 'web' },
    }));

    expect(requests[0]?.previousResponseId).toBe('resp_stale');
    expect(clearedSessions).toEqual(['session-repair-reset']);
  });
});
