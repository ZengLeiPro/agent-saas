import { describe, expect, it, vi } from 'vitest';

import {
  processWsEvent,
  type MessagesController,
  type WsProcessingContext,
} from '../../../shared/src/lib/wsEventProcessor.js';
import type { MessageItem, MessageItemInput } from '../../../shared/src/types/message.js';
import type { WsEvent } from '../../../shared/src/types/ws.js';

function createTestRig(initial: MessageItem[] = []) {
  const messages: MessageItem[] = [...initial];
  let id = 0;
  const msg: MessagesController = {
    messagesRef: { current: messages },
    addMessage(message: MessageItemInput): number {
      messages.push({ id: `m-${++id}`, ...message } as MessageItem);
      return messages.length - 1;
    },
    updateMessageAt(index: number, updater: (msg: MessageItem) => MessageItem): void {
      messages[index] = updater(messages[index]);
    },
    setMessages(nextMessages: MessageItemInput[]): void {
      messages.splice(0, messages.length, ...(nextMessages as MessageItem[]));
      msg.messagesRef.current = messages;
    },
    triggerScroll: vi.fn(),
  };
  const ctx: WsProcessingContext = {
    msg,
    session: {
      setIsNewSession: vi.fn(),
      setSessionId: vi.fn(),
      loadSessions: vi.fn(async () => {}),
      updateSessionTitle: vi.fn(),
      updateSessionMeta: vi.fn(),
      removeSession: vi.fn(),
      upsertSession: vi.fn(),
    },
    selectedModelRef: { current: null },
    voiceCallbackRef: { current: undefined },
    streamIdRef: { current: null },
    lastEventIdRef: { current: null },
    userMsgIndex: -1,
  };
  return { messages, ctx };
}

function process(event: WsEvent, ctx: WsProcessingContext): void {
  processWsEvent(
    event,
    ctx,
    { currentBlockIndex: -1, currentBlockType: null },
    { value: 'session-1' },
    'session-1',
  );
}

describe('wsEventProcessor session events', () => {
  it('upserts a local placeholder when a session id is assigned', () => {
    const { ctx } = createTestRig();
    ctx.selectedModelRef.current = 'opus-test';

    processWsEvent(
      { type: 'session', sessionId: 'new-session-1' },
      ctx,
      { currentBlockIndex: -1, currentBlockType: null },
      { value: null },
      null,
    );

    expect(ctx.session.setIsNewSession).toHaveBeenCalledWith(false);
    expect(ctx.session.setSessionId).toHaveBeenCalledWith('new-session-1');
    expect(ctx.session.upsertSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'new-session-1',
      model: 'opus-test',
    }));
  });
});

describe('wsEventProcessor terminal errors', () => {
  it('finalizes a half-open streaming text block when done arrives without block_end', () => {
    const { messages, ctx } = createTestRig([
      {
        id: 'assistant-1',
        type: 'text',
        content: 'partial answer',
        streaming: true,
      },
    ]);
    const block = { currentBlockIndex: 0, currentBlockType: 'text' };

    const result = processWsEvent(
      { type: 'done' },
      ctx,
      block,
      { value: 'session-1' },
      'session-1',
    );

    expect(result).toBe('done');
    expect(messages[0]).toMatchObject({
      type: 'text',
      streaming: false,
    });
    expect(block).toEqual({ currentBlockIndex: -1, currentBlockType: null });
  });

  it('finalizes the previous streaming block before starting a new block', () => {
    const { messages, ctx } = createTestRig();
    const block = { currentBlockIndex: -1, currentBlockType: null };

    processWsEvent(
      { type: 'block_start', blockType: 'text' },
      ctx,
      block,
      { value: 'session-1' },
      'session-1',
    );
    processWsEvent(
      { type: 'text', content: 'hello' },
      ctx,
      block,
      { value: 'session-1' },
      'session-1',
    );
    processWsEvent(
      { type: 'block_start', blockType: 'thinking' },
      ctx,
      block,
      { value: 'session-1' },
      'session-1',
    );

    expect(messages[0]).toMatchObject({
      type: 'text',
      content: 'hello',
      streaming: false,
    });
    expect(messages[1]).toMatchObject({
      type: 'thinking',
      streaming: true,
    });
  });

  it('records thinking duration when the thinking block ends', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T00:00:00.000Z'));
    try {
      const { messages, ctx } = createTestRig();
      const block = { currentBlockIndex: -1, currentBlockType: null };

      processWsEvent(
        { type: 'block_start', blockType: 'thinking' },
        ctx,
        block,
        { value: 'session-1' },
        'session-1',
      );
      vi.advanceTimersByTime(1234);
      processWsEvent(
        { type: 'block_end', blockType: 'thinking' },
        ctx,
        block,
        { value: 'session-1' },
        'session-1',
      );

      expect(messages[0]).toMatchObject({
        type: 'thinking',
        streaming: false,
        durationMs: 1234,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('records thinking duration when a new block starts before thinking ends', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T00:00:00.000Z'));
    try {
      const { messages, ctx } = createTestRig();
      const block = { currentBlockIndex: -1, currentBlockType: null };

      processWsEvent(
        { type: 'block_start', blockType: 'thinking' },
        ctx,
        block,
        { value: 'session-1' },
        'session-1',
      );
      vi.advanceTimersByTime(2400);
      processWsEvent(
        { type: 'block_start', blockType: 'text' },
        ctx,
        block,
        { value: 'session-1' },
        'session-1',
      );

      expect(messages[0]).toMatchObject({
        type: 'thinking',
        streaming: false,
        durationMs: 2400,
      });
      expect(messages[1]).toMatchObject({
        type: 'text',
        streaming: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks the current user message failed when done carries an error without client_msg_id', () => {
    const { messages, ctx } = createTestRig([
      {
        id: 'user-1',
        type: 'user',
        content: 'please run',
        status: 'sent',
      },
    ]);
    ctx.userMsgIndex = 0;

    const result = processWsEvent(
      { type: 'done', error: 'model returned empty turn' },
      ctx,
      { currentBlockIndex: -1, currentBlockType: null },
      { value: 'session-1' },
      'session-1',
    );

    expect(result).toBe('done');
    expect(messages[0]).toMatchObject({
      type: 'user',
      status: 'failed',
      // 用户侧通俗文案;原始 model error 留 server.log + PG runtime_events
      failedReason: '异常中断，请继续对话',
    });
  });

  it('uses the model request message only for model HTTP 5xx failures', () => {
    const { messages, ctx } = createTestRig([
      {
        id: 'user-1',
        type: 'user',
        content: 'continue',
        status: 'sent',
      },
    ]);
    ctx.userMsgIndex = 0;

    processWsEvent(
      {
        type: 'done',
        error: 'Responses API HTTP 500: {"error":{"message":"Post \\"https://chatgpt.com/backend-api/codex/responses\\": EOF","type":"server_error"}}',
      },
      ctx,
      { currentBlockIndex: -1, currentBlockType: null },
      { value: 'session-1' },
      'session-1',
    );

    expect(messages[0]).toMatchObject({
      type: 'user',
      status: 'failed',
      failedReason: '模型请求错误，请稍后重试',
    });
  });

  it('does not mask non-model runtime errors as model request errors', () => {
    const { messages, ctx } = createTestRig([
      {
        id: 'user-1',
        type: 'user',
        content: 'continue',
        status: 'sent',
      },
    ]);
    ctx.userMsgIndex = 0;

    processWsEvent(
      {
        type: 'done',
        error: 'approval not found: approval-1',
      },
      ctx,
      { currentBlockIndex: -1, currentBlockType: null },
      { value: 'session-1' },
      'session-1',
    );

    expect(messages[0]).toMatchObject({
      type: 'user',
      status: 'failed',
      failedReason: '异常中断，请继续对话',
    });
  });
});

describe('wsEventProcessor runtime and tool execution status', () => {
  it('shows a runtime status after stream_id and removes it when visible content starts', () => {
    const { messages, ctx } = createTestRig([
      {
        id: 'user-1',
        type: 'user',
        content: 'run',
        status: 'pending',
        clientMsgId: 'client-1',
      },
    ]);
    const block = { currentBlockIndex: -1, currentBlockType: null };

    processWsEvent(
      { type: 'stream_id', streamId: 'stream-1', runId: 'run-1', client_msg_id: 'client-1' },
      ctx,
      block,
      { value: 'session-1' },
      'session-1',
    );

    expect(messages.at(-1)).toMatchObject({
      type: 'runtime_status',
      status: 'queued',
      streamId: 'stream-1',
      runId: 'run-1',
    });

    processWsEvent(
      { type: 'block_start', blockType: 'thinking' },
      ctx,
      block,
      { value: 'session-1' },
      'session-1',
    );

    expect(messages.some((message) => message.type === 'runtime_status')).toBe(false);
    expect(messages.at(-1)).toMatchObject({
      type: 'thinking',
      streaming: true,
    });
  });

  it('tracks tool execution progress without marking the tool result ready', () => {
    const { messages, ctx } = createTestRig();
    const block = { currentBlockIndex: -1, currentBlockType: null };

    processWsEvent(
      { type: 'block_start', blockType: 'tool_use', toolId: 'call-1', toolName: 'Shell' },
      ctx,
      block,
      { value: 'session-1' },
      'session-1',
    );
    processWsEvent(
      { type: 'tool_input', toolId: 'call-1', toolName: 'Shell', content: '{"cmd":"sleep 20"}' },
      ctx,
      block,
      { value: 'session-1' },
      'session-1',
    );
    processWsEvent(
      { type: 'block_end', blockType: 'tool_use', toolName: 'Shell' },
      ctx,
      block,
      { value: 'session-1' },
      'session-1',
    );
    processWsEvent(
      { type: 'tool_execution', phase: 'started', toolId: 'call-1', toolName: 'Shell', invocationId: 'run-1:call-1' },
      ctx,
      block,
      { value: 'session-1' },
      'session-1',
    );
    processWsEvent(
      { type: 'tool_execution', phase: 'progress', toolId: 'call-1', invocationId: 'run-1:call-1', content: 'still running' },
      ctx,
      block,
      { value: 'session-1' },
      'session-1',
    );

    expect(messages[0]).toMatchObject({
      type: 'tool_use',
      toolId: 'call-1',
      executionStatus: 'running',
      lastProgress: 'still running',
    });
    expect(messages[0].type === 'tool_use' ? messages[0].resultReady : undefined).not.toBe(true);
  });

  it('marks a tool completed only when the final tool_result arrives', () => {
    const { messages, ctx } = createTestRig([
      {
        id: 'tool-1',
        type: 'tool_use',
        toolName: 'Shell',
        toolInput: '{"cmd":"echo done"}',
        toolId: 'call-1',
        executionStatus: 'running',
      },
    ]);

    process(
      {
        type: 'tool_execution',
        phase: 'completed',
        toolId: 'call-1',
        toolName: 'Shell',
        invocationId: 'run-1:call-1',
        status: 'success',
        durationMs: 1234,
      },
      ctx,
    );

    expect(messages[0]).toMatchObject({
      type: 'tool_use',
      executionStatus: 'completed',
      durationMs: 1234,
    });
    expect(messages[0].type === 'tool_use' ? messages[0].resultReady : undefined).not.toBe(true);

    process(
      { type: 'tool_result', toolId: 'call-1', toolName: 'Shell', result: 'done' },
      ctx,
    );

    expect(messages[0]).toMatchObject({
      type: 'tool_use',
      executionStatus: 'completed',
      resultReady: true,
      result: 'done',
    });
  });
});

describe('wsEventProcessor pending interaction replay', () => {
  it('adds pending ask_user and plan approval messages without duplicating existing interactionIds', () => {
    const { messages, ctx } = createTestRig([
      {
        id: 'existing',
        type: 'permission_request',
        interactionId: 'plan-1',
        toolName: '规划方案审批',
        toolInput: '旧计划',
        status: 'pending',
      },
    ]);

    process({
      type: 'pending_interactions',
      interactions: [
        {
          interactionId: 'plan-1',
          type: 'permission_request',
          toolName: 'ExitPlanMode',
          planContent: '不应重复加入',
        },
        {
          interactionId: 'plan-2',
          type: 'permission_request',
          toolName: 'ExitPlanMode',
          planContent: '新计划正文',
        },
        {
          interactionId: 'ask-1',
          type: 'ask_user',
          questions: [
            {
              question: '继续吗？',
              header: '确认',
              options: [{ label: '继续', description: '继续执行' }],
              multiSelect: false,
            },
          ],
        },
      ],
    }, ctx);

    expect(messages).toHaveLength(3);
    expect(messages[1]).toMatchObject({
      type: 'permission_request',
      interactionId: 'plan-2',
      toolName: '规划方案审批',
      toolInput: '新计划正文',
      status: 'pending',
    });
    expect(messages[2]).toMatchObject({
      type: 'ask_user',
      interactionId: 'ask-1',
      status: 'pending',
    });
  });

  it('marks replayed pending interactions as resolved', () => {
    const { messages, ctx } = createTestRig([
      {
        id: 'pending',
        type: 'ask_user',
        interactionId: 'ask-2',
        questions: [],
        status: 'pending',
      },
    ]);

    process({ type: 'interaction_resolved', sessionId: 'session-1', interactionId: 'ask-2' }, ctx);

    expect(messages[0]).toMatchObject({
      type: 'ask_user',
      interactionId: 'ask-2',
      status: 'answered',
    });
  });
});

describe('wsEventProcessor artifact_created', () => {
  it('renders a CreateArtifact delivery as a file_download card carrying artifactId', () => {
    const { messages, ctx } = createTestRig();

    process(
      {
        type: 'artifact_created',
        artifactId: 'artifact_abc123',
        fileName: 'report.pdf',
        kind: 'file',
        sourcePath: 'assets/20260702/report.pdf',
        sizeBytes: 12345,
        mimeType: 'application/pdf',
        sha256: 'deadbeef',
        owner: 'alice',
      },
      ctx,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'file_download',
      fileName: 'report.pdf',
      fileType: 'application/pdf',
      filePath: 'assets/20260702/report.pdf',
      fileSize: 12345,
      artifactId: 'artifact_abc123',
      artifactKind: 'file',
      mimeType: 'application/pdf',
      owner: 'alice',
    });
  });

  it('falls back to fileName when sourcePath is omitted', () => {
    const { messages, ctx } = createTestRig();

    process(
      {
        type: 'artifact_created',
        artifactId: 'artifact_xyz',
        fileName: 'shot.png',
        kind: 'screenshot',
      },
      ctx,
    );

    expect(messages[0]).toMatchObject({
      type: 'file_download',
      fileName: 'shot.png',
      filePath: 'shot.png',
      fileSize: 0,
      artifactId: 'artifact_xyz',
      artifactKind: 'screenshot',
    });
  });
});

describe('wsEventProcessor dedicated tool passthrough', () => {
  // 回归：拥有独立卡片的工具不能再叠加通用工具骨架。前端兜底覆盖旧 buffer
  // 与跨版本重连，block_start / tool_execution / tool_result 三路都必须跳过。
  for (const toolName of ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'Agent']) {
    it(`ignores block_start(tool_use) for ${toolName}`, () => {
      const { messages, ctx } = createTestRig();
      const block = { currentBlockIndex: -1, currentBlockType: null };
      processWsEvent(
        { type: 'block_start', blockType: 'tool_use', toolId: 't1', toolName },
        ctx, block, { value: 'session-1' }, 'session-1',
      );
      // tool_input / block_end 由于 currentBlockType 仍为 null 自然跳过
      processWsEvent(
        { type: 'tool_input', toolId: 't1', toolName, content: '{}' },
        ctx, block, { value: 'session-1' }, 'session-1',
      );
      processWsEvent(
        { type: 'block_end', blockType: 'tool_use', toolName },
        ctx, block, { value: 'session-1' }, 'session-1',
      );
      expect(messages.some(m => m.type === 'tool_use')).toBe(false);
    });

    it(`ignores tool_execution phase=started for ${toolName}`, () => {
      const { messages, ctx } = createTestRig();
      process(
        { type: 'tool_execution', phase: 'started', toolId: 't1', toolName },
        ctx,
      );
      expect(messages.some(m => m.type === 'tool_use')).toBe(false);
    });

    it(`ignores tool_result for ${toolName} and does not spawn a bare tool_result card`, () => {
      const { messages, ctx } = createTestRig();
      process(
        { type: 'tool_result', toolId: 't1', toolName, result: 'ignored' },
        ctx,
      );
      expect(messages.some(m => m.type === 'tool_result')).toBe(false);
    });
  }

  it('still renders regular tools via tool_execution', () => {
    const { messages, ctx } = createTestRig();
    process(
      { type: 'tool_execution', phase: 'started', toolId: 't1', toolName: 'Bash' },
      ctx,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: 'tool_use', toolName: 'Bash' });
  });

  it('coexists cleanly: only ask_user card remains for AskUserQuestion end-to-end', () => {
    // 端到端回归：replay/durable 通道曾同时投出 tool_execution(AskUserQuestion) +
    // ask_user,前端会渲染成"AskUserQuestion 执行中" + "Agent Question / Answered"
    // 两条。修复后 tool_execution 分支挡住,只留 ask_user 卡片。
    const { messages, ctx } = createTestRig();
    process({ type: 'tool_execution', phase: 'started', toolId: 't1', toolName: 'AskUserQuestion' }, ctx);
    process({
      type: 'ask_user', interactionId: 'ix-1',
      questions: [{ question: 'q?', header: 'H', options: [{ label: 'A', description: '' }], multiSelect: false }],
    }, ctx);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: 'ask_user', interactionId: 'ix-1' });
  });

  it('replaces an old generic Agent row and keeps subagent_start idempotent', () => {
    const { messages, ctx } = createTestRig();
    messages.push({
      id: 'legacy-agent-row',
      type: 'tool_use',
      toolName: 'Agent',
      toolInput: '{}',
      toolId: 'call-agent-1',
      executionStatus: 'running',
    });

    process({
      type: 'subagent_start',
      toolId: 'call-agent-1',
      agentType: '检索代码路径',
    }, ctx);
    process({
      type: 'subagent_start',
      toolId: 'call-agent-1',
      agentType: '检索代码路径',
    }, ctx);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: 'legacy-agent-row',
      type: 'subagent',
      toolId: 'call-agent-1',
      agentType: '检索代码路径',
      status: 'running',
    });
  });

  it('keeps the real child terminal status and drill-down metadata', () => {
    const { messages, ctx } = createTestRig();
    process({
      type: 'subagent_start',
      toolId: 'call-agent-failed',
      agentType: '调研金球奖',
      childSessionId: 'sub-child',
      childRunId: 'child-run',
      model: 'gpt-5.6',
    }, ctx);
    process({
      type: 'subagent_end',
      toolId: 'call-agent-failed',
      agentType: '调研金球奖',
      status: 'failed',
      childSessionId: 'sub-child',
      childRunId: 'child-run',
      model: 'gpt-5.6',
      durationMs: 600_000,
      totalTokens: 123_456,
      toolUseCount: 67,
      turnCount: 42,
      errorMessage: 'upstream EOF',
      resultPreview: '部分材料',
    }, ctx);

    expect(messages).toEqual([expect.objectContaining({
      type: 'subagent',
      status: 'failed',
      childSessionId: 'sub-child',
      childRunId: 'child-run',
      turnCount: 42,
      errorMessage: 'upstream EOF',
    })]);
  });
});
