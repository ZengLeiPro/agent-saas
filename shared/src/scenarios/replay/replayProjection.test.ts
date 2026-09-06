import { describe, expect, it } from 'vitest';

import { knowledgeQaScript } from './knowledgeQaScript';
import {
  buildReplayDetail,
  collectReplayTraceEvents,
  projectLegacyReplayMessages,
  resolveReplayApproval,
} from './replayProjection';
import type { ReplayScript } from './types';
import type { ApiTranscriptBlock } from '../../types';
import type { WorkflowTraceEventV1 } from '../../schemas/workflowTrace';

function textBlock(
  id: string,
  content: string,
  extra: Partial<ApiTranscriptBlock> = {},
): ApiTranscriptBlock {
  return {
    id,
    kind: 'text',
    title: '回复',
    defaultOpen: true,
    content,
    ...extra,
  } as ApiTranscriptBlock;
}

function scriptWith(steps: ReplayScript['steps']): ReplayScript {
  return { scenarioId: 'unit-script', title: '单测剧本', steps, sources: [] };
}

describe('replayProjection', () => {
  it('回放详情与真实会话同形，块数即行数', () => {
    const blocks = [textBlock('a', '甲'), textBlock('b', '乙')];
    expect(buildReplayDetail(blocks)).toEqual({
      sessionId: 'scenario-replay',
      stats: { lines: 2, parsedLines: 2, parseErrors: 0 },
      blocks,
    });
  });

  it('真实剧本按已推进步数产出消息，未推进时只给入口', () => {
    const entryOnly = projectLegacyReplayMessages(knowledgeQaScript, 0, {});
    expect(entryOnly).toHaveLength(1);
    const advanced = projectLegacyReplayMessages(knowledgeQaScript, 1, {});
    expect(advanced.length).toBeGreaterThan(entryOnly.length);
  });

  it('replayInstant 文本投影成系统事件，不伪装成 Agent 回复', () => {
    const script = scriptWith([
      {
        caption: '第一步',
        blocks: [
          textBlock('entry', '请开始演示', { kind: 'prompt', title: '用户消息' }),
          textBlock('gap', '三天后', { replayInstant: true, title: '时间推进' }),
          textBlock('reply', '已完成核对'),
        ],
      },
    ]);
    const messages = projectLegacyReplayMessages(script, 1, {});
    const gap = messages.find((message) => message.id === 'gap');
    expect(gap).toMatchObject({ type: 'system_event', title: '时间推进', content: '三天后' });
    expect(messages.find((message) => message.id === 'reply')).toMatchObject({ type: 'text' });
  });

  it('transformBlocks 与 streamingBlockId 只影响呈现节奏，不改映射路径', () => {
    const script = scriptWith([
      {
        caption: '第一步',
        blocks: [textBlock('entry', '开始', { kind: 'prompt' }), textBlock('reply', '完整回复')],
      },
    ]);
    const messages = projectLegacyReplayMessages(
      script,
      1,
      {},
      {
        transformBlocks: (blocks) =>
          blocks.map((block) => (block.id === 'reply' ? { ...block, content: '完整' } : block)),
        streamingBlockId: 'reply',
      },
    );
    const reply = messages.find((message) => message.id === 'reply');
    expect(reply).toMatchObject({ type: 'text', content: '完整', streaming: true });
  });

  it('Trace 事件按步累积，批准与退回各自追加自己的后续', () => {
    let sequence = 0;
    const event = (id: string): WorkflowTraceEventV1 => ({
      schemaVersion: 1,
      id,
      sequence: sequence++,
      workflowId: 'unit-workflow',
      instanceId: 'unit-instance',
      authority: 'simulation',
      type: 'step',
      stepId: id,
      status: 'completed',
    });
    const script: ReplayScript = {
      ...scriptWith([
        {
          caption: '待审批',
          blocks: [],
          trace: {
            events: [event('s1')],
            approvedEvents: [event('approved')],
            rejectedEvents: [event('rejected')],
          },
        },
        { caption: '收尾', blocks: [], trace: { events: [event('s2')] } },
      ]),
      traceEntryEvents: [event('entry')],
    };
    expect(collectReplayTraceEvents(script, 0, {}).map((e) => e.id)).toEqual(['entry']);
    expect(collectReplayTraceEvents(script, 1, { 0: 'approved' }).map((e) => e.id)).toEqual([
      'entry',
      's1',
      'approved',
    ]);
    expect(collectReplayTraceEvents(script, 2, { 0: 'rejected' }).map((e) => e.id)).toEqual([
      'entry',
      's1',
      'rejected',
      's2',
    ]);
  });

  it('人审参数优先取剧本 approval，其次由 gate 事件归一，都没有则不阻断', () => {
    const gate: WorkflowTraceEventV1 = {
      schemaVersion: 1,
      id: 'gate-1',
      sequence: 0,
      workflowId: 'unit-workflow',
      instanceId: 'unit-instance',
      authority: 'simulation',
      type: 'gate_requested',
      stepId: 'step-1',
      gateId: 'gate-1',
      title: '需要审批',
      description: '写入前确认',
      facts: [{ label: '金额', value: '¥1' }],
      approveLabel: '批准',
    };
    expect(resolveReplayApproval(undefined)).toBeUndefined();
    expect(resolveReplayApproval({ caption: '无审批', blocks: [] })).toBeUndefined();
    expect(
      resolveReplayApproval({ caption: '门禁', blocks: [], trace: { events: [gate] } }),
    ).toMatchObject({ title: '需要审批', approveLabel: '批准' });
    expect(
      resolveReplayApproval({
        caption: '剧本审批',
        blocks: [],
        trace: { events: [gate] },
        approval: {
          title: '剧本优先',
          description: '以剧本为准',
          facts: [],
          approveLabel: '批准并写入',
          approvedBlocks: [],
        },
      }),
    ).toMatchObject({ title: '剧本优先' });
  });
});
