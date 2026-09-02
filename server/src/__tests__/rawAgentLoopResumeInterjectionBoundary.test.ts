import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  writeFileToolDescriptor,
  type AuthorizedToolCall,
  type ToolCallContext,
  type ToolDescriptor,
  type ToolResult,
  type ToolRuntime,
} from '../agent/toolRuntime.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { EventBackedApprovalStore } from '../runtime/approvalStore.js';
import { FileEventStore } from '../runtime/fileEventStore.js';
import { LegacyTranscriptProjection } from '../runtime/legacyTranscriptProjection.js';
import { RawAgentLoop } from '../runtime/rawAgentLoop.js';
import type { RunStore } from '../runtime/runStore.js';
import type { ModelAdapter, ModelEvent, ModelRequest, QueuedInterjection, RunContext } from '../runtime/types.js';
import type { OutboundEvent } from '../types/index.js';

class FinalTextAdapter implements ModelAdapter {
  requests: ModelRequest[] = [];

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(request);
    yield { type: 'completed', content: '已处理恢复后的补充。', toolCalls: [] };
  }
}

class ResumeToolRuntime implements ToolRuntime {
  readonly invocations: string[] = [];
  private readonly descriptor: ToolDescriptor = {
    ...writeFileToolDescriptor,
    id: 'resume-test-tool',
    name: 'ResumeTestTool',
    displayName: '恢复测试工具',
    risk: 'safe',
    approvalMode: 'never',
  };

  list(): ToolDescriptor[] {
    return [this.descriptor];
  }

  async invoke<TInput>(_call: AuthorizedToolCall<TInput>, context: ToolCallContext): Promise<ToolResult> {
    this.invocations.push(context.toolCallId!);
    return { content: `executed ${context.toolCallId}` };
  }
}

async function collect(stream: AsyncIterable<OutboundEvent>): Promise<OutboundEvent[]> {
  const events: OutboundEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function runningRunStore(runId: string, sessionId: string, apply: () => void): RunStore {
  return {
    get: vi.fn(async () => ({
      runId, sessionId, status: 'running',
      requestedAt: '2026-09-02T18:00:00.000Z', updatedAt: '2026-09-02T18:00:00.000Z', metadata: {},
    })),
    markSteeringInputsApplied: vi.fn(async (_targetRunId, sourceRunIds) => {
      apply();
      return sourceRunIds;
    }),
    trySealSteeringInputWindow: vi.fn(async () => true),
  } as unknown as RunStore;
}

describe('RawAgentLoop resumed user input boundaries', () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
    cleanupDirs.clear();
  });

  it('stops remaining serial tools after an approval resumes and applies the message in the same run', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-resume-approval-interjection-'));
    cleanupDirs.add(cwd);
    const sessionId = 'session-resume-approval-interjection';
    const runId = 'run-resume-approval-interjection';
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    const approvalStore = new EventBackedApprovalStore(eventStore, sessionId, DEFAULT_TENANT_ID);
    await eventStore.appendBatch([
      { type: 'user_message', runId, sessionId, content: '执行三个操作' },
      {
        type: 'assistant_tool_calls', runId, sessionId, content: '',
        toolCalls: [1, 2, 3].map((index) => ({
          id: `call_resume_${index}`, name: 'ResumeTestTool', arguments: JSON.stringify({ index }),
        })),
      },
    ], { tenantId: DEFAULT_TENANT_ID });
    const approval = await approvalStore.create({
      sessionId, runId, toolCallId: 'call_resume_1', toolId: 'resume-test-tool',
      toolName: 'ResumeTestTool', input: { index: 1 },
    });
    let queued: QueuedInterjection[] = [{
      inputId: 'input-resume-approval', sourceRunId: 'source-resume-approval',
      message: { channel: 'web', chatId: sessionId, content: '停止剩余工具，先处理补充' },
      prompt: '停止剩余工具，先处理补充',
    }];
    const adapter = new FinalTextAdapter();
    const toolRuntime = new ResumeToolRuntime();
    const runStore = runningRunStore(runId, sessionId, () => { queued = []; });
    const loop = new RawAgentLoop({
      modelAdapter: adapter, eventStore, approvalStore, runStore,
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')), toolRuntime,
    });

    const events = await collect(loop.resumeApproval({
      approvalId: approval.id, response: { allow: true }, instructions: '继续。', maxTurns: 1,
    }, {
      runId, sessionId, model: 'gpt-5.5', cwd, tenantId: DEFAULT_TENANT_ID,
      channelContext: { channel: 'web' }, approvalPolicy: { autoApproveTools: true },
      loadQueuedInterjections: async () => queued,
    }));

    expect(toolRuntime.invocations).toEqual(['call_resume_1']);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_result', toolId: 'call_resume_2', toolResultMetadata: { skipped: true, reason: 'user_interjection' } }),
      expect.objectContaining({ type: 'tool_result', toolId: 'call_resume_3', toolResultMetadata: { skipped: true, reason: 'user_interjection' } }),
      expect.objectContaining({ type: 'interjection_applied', sourceRunIds: ['source-resume-approval'] }),
    ]));
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0]?.messages.at(-1)).toEqual({ role: 'user', content: '停止剩余工具，先处理补充' });
  });

  it('applies message and compact control queued after AskUserQuestion resume before the next model request', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-resume-interaction-interjection-'));
    cleanupDirs.add(cwd);
    const sessionId = 'session-resume-interaction-interjection';
    const runId = 'run-resume-interaction-interjection';
    const interactionId = 'interaction-resume-interjection';
    const eventStore = new FileEventStore(join(cwd, 'session.runtime-events.jsonl'), DEFAULT_TENANT_ID);
    await eventStore.appendBatch([
      { type: 'user_message', runId, sessionId, content: '先问我' },
      {
        type: 'assistant_tool_calls', runId, sessionId, content: '',
        toolCalls: [{
          id: 'call_resume_ask', name: 'AskUserQuestion',
          arguments: JSON.stringify({ questions: [{ header: '分支', question: '选哪个？', options: [{ label: 'main', description: '主分支' }] }] }),
        }],
      },
      {
        type: 'interaction_requested', runId, sessionId, toolCallId: 'call_resume_ask', interactionId,
        interactionType: 'ask_user', userId: 'user-1', toolId: 'AskUserQuestion', toolName: 'AskUserQuestion',
        displayName: '询问用户', questions: [{ header: '分支', question: '选哪个？', options: [{ label: 'main', description: '主分支' }] }],
      },
      {
        type: 'interaction_resolved', runId, sessionId, toolCallId: 'call_resume_ask', interactionId,
        interactionType: 'ask_user', userId: 'user-1', response: { answers: { branch: 'main' } },
      },
    ], { tenantId: DEFAULT_TENANT_ID });
    let queued: QueuedInterjection[] = [{
      inputId: 'input-resume-interaction', sourceRunId: 'source-resume-interaction',
      message: { channel: 'web', chatId: sessionId, content: '回答后再补充一句' },
      prompt: '回答后再补充一句',
    }, {
      inputId: 'input-resume-compact', sourceRunId: 'source-resume-compact',
      message: { channel: 'web', chatId: sessionId, content: '/compact' }, prompt: '/compact',
    }];
    const adapter = new FinalTextAdapter();
    const runStore = runningRunStore(runId, sessionId, () => { queued = []; });
    const loop = new RawAgentLoop({
      modelAdapter: adapter, eventStore, runStore,
      approvalStore: new EventBackedApprovalStore(eventStore, sessionId, DEFAULT_TENANT_ID),
      transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
    });

    const events = await collect(loop.resumeInteraction({
      interactionId, response: { answers: { branch: 'main' } }, instructions: '继续。', maxTurns: 1,
    }, {
      runId, sessionId, model: 'gpt-5.5', cwd, tenantId: DEFAULT_TENANT_ID,
      channelContext: { channel: 'web' }, loadQueuedInterjections: async () => queued,
    }));

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'interjection_applied',
        sourceRunIds: ['source-resume-interaction', 'source-resume-compact'],
      }),
      expect.objectContaining({ type: 'compaction_start' }),
    ]));
    expect(adapter.requests).toHaveLength(2);
    expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('回答后再补充一句');
    expect(adapter.requests[1]?.messages.at(-1)).toMatchObject({
      role: 'user', content: expect.stringContaining('<context-checkpoint'),
    });
  });
});
