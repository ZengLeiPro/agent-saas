import { describe, expect, it } from 'vitest';

import type { MessageItem, RenderItem } from '../types/message';
import { partitionAssistantTurn, selectTurnProcessSummary } from './partitionAssistantTurn';

function text(id: string, content: string, extra: Partial<Extract<MessageItem, { type: 'text' }>> = {}): RenderItem {
  return { id, type: 'text', content, ...extra };
}

function tool(id: string, extra: Partial<Extract<MessageItem, { type: 'tool_use' }>> = {}): MessageItem {
  return {
    id,
    type: 'tool_use',
    toolName: extra.toolName ?? 'WebSearch',
    toolId: extra.toolId ?? id,
    toolInput: extra.toolInput ?? '{}',
    executionStatus: extra.executionStatus ?? 'completed',
    resultReady: extra.resultReady ?? true,
    result: extra.result ?? 'ok',
    ...extra,
  };
}

function group(id: string, items: MessageItem[], isActive = false): RenderItem {
  return { type: 'activity_group', id, items, isActive };
}

function screenshotTurn(): RenderItem[] {
  return [
    group('g1', [tool('t1', { durationMs: 1200 })]),
    text('c1', '先核对记忆里有没有 WorkBuddy 的既有口径'),
    group('g2', [tool('t2', { durationMs: 10_000 }), tool('t3', { durationMs: 4000 })]),
    text('c2', '记忆里只有 7 月口径'),
    text('final', '结论先说：腾讯到现在也没公开绝对 MAU', { finalOutput: true }),
  ];
}

describe('partitionAssistantTurn', () => {
  it('截图结构：两组活动 + 两段 commentary + final → process=4，final=1，应收起', () => {
    const partition = partitionAssistantTurn(screenshotTurn());
    expect(partition.process.map((item) => item.id)).toEqual(['g1', 'c1', 'g2', 'c2']);
    expect(partition.final.map((item) => item.id)).toEqual(['final']);
    expect(partition.pierce).toEqual([]);
    expect(partition.keepOut).toEqual([]);
    expect(partition.shouldFold).toBe(true);
    expect(selectTurnProcessSummary(partition.process)).toMatchObject({
      count: 4,
      title: '过程记录',
      subtitle: '4 项 · 15s',
    });
  });

  it('没有 finalOutput 时不折，即使最后一条是 text', () => {
    const items = [
      group('g1', [tool('t1')]),
      text('last', '这只是阶段性正文'),
    ];
    const partition = partitionAssistantTurn(items);
    expect(partition.process.map((item) => item.id)).toEqual(['g1', 'last']);
    expect(partition.final).toEqual([]);
    expect(partition.shouldFold).toBe(false);
  });

  it('终答仍在 streaming 时不折', () => {
    const items = [
      group('g1', [tool('t1')]),
      text('final', '正在写结论', { finalOutput: true, streaming: true }),
    ];
    expect(partitionAssistantTurn(items).shouldFold).toBe(false);
  });

  it('AskUser / permission / Artifact 刺破，不进过程折', () => {
    const items: RenderItem[] = [
      group('g1', [tool('t1')]),
      {
        id: 'ask',
        type: 'ask_user',
        interactionId: 'ask-1',
        questions: [{ question: '选一个方向', header: '方向', options: [{ label: 'A', description: 'a' }], multiSelect: false }],
        status: 'pending',
      },
      {
        id: 'perm',
        type: 'permission_request',
        interactionId: 'perm-1',
        toolName: 'Write',
        toolInput: '{}',
        status: 'pending',
      },
      {
        id: 'file',
        type: 'file_download',
        fileName: '结果.xlsx',
        fileType: 'xlsx',
        filePath: 'assets/结果.xlsx',
        fileSize: 10,
        artifactId: 'art-1',
      },
      text('c1', '阶段性说明'),
      text('final', '结论', { finalOutput: true }),
    ];
    const partition = partitionAssistantTurn(items);
    expect(partition.process.map((item) => item.id)).toEqual(['g1', 'c1']);
    expect(partition.pierce.map((item) => item.id)).toEqual(['ask', 'perm', 'file']);
    expect(partition.shouldFold).toBe(true);
  });

  it('mobile 步骤节 keepOut，节内 AskUser 不进过程折', () => {
    const start = {
      type: 'business_step',
      id: 'start-1',
      anchorMessageId: 'todo-1',
      kind: 'start',
    } as Extract<RenderItem, { type: 'business_step' }>;
    const ask = {
      id: 'ask',
      type: 'ask_user',
      interactionId: 'ask-1',
      questions: [{ question: '选一个方向', header: '方向', options: [{ label: 'A', description: 'a' }], multiSelect: false }],
      status: 'pending',
    } as RenderItem;
    const section = {
      type: 'business_step_section',
      id: 'section-1',
      start,
      items: [text('in-section', '步骤过程'), ask],
      isActive: false,
    } as RenderItem;
    const items = [
      section,
      group('g1', [tool('t1')]),
      text('c1', '节外 commentary'),
      text('final', '完成', { finalOutput: true }),
    ];
    const partition = partitionAssistantTurn(items);
    expect(partition.keepOut.map((item) => item.id)).toEqual(['section-1']);
    expect(partition.process.map((item) => item.id)).toEqual(['g1', 'c1']);
    expect(partition.pierce).toEqual([]);
    expect(partition.shouldFold).toBe(true);
  });

  it('业务步骤计划卡 keepOut，不进过程折', () => {
    const plan = {
      type: 'business_step',
      id: 'plan-1',
      anchorMessageId: 'todo-1',
      kind: 'plan',
      todos: [],
    } as RenderItem;
    const items = [
      plan,
      group('g1', [tool('t1')]),
      text('c1', '处理中'),
      text('final', '完成', { finalOutput: true }),
    ];
    const partition = partitionAssistantTurn(items);
    expect(partition.keepOut.map((item) => item.id)).toEqual(['plan-1']);
    expect(partition.process.map((item) => item.id)).toEqual(['g1', 'c1']);
    expect(partition.shouldFold).toBe(true);
  });

  it('失败轮没有 finalOutput，整段不折', () => {
    const items = [
      group('g1', [tool('t1', { executionStatus: 'failed', resultReady: true })]),
      text('err', '执行失败了'),
    ];
    expect(partitionAssistantTurn(items).shouldFold).toBe(false);
  });

  it('空过程纯终答不渲染折行', () => {
    const partition = partitionAssistantTurn([text('final', '直接回答', { finalOutput: true })]);
    expect(partition.process).toEqual([]);
    expect(partition.shouldFold).toBe(false);
  });

  it('活动组仍 isActive 时不折', () => {
    const items = [
      group('g1', [tool('t1', { executionStatus: 'running', resultReady: false, streaming: true })], true),
      text('final', '结论', { finalOutput: true }),
    ];
    expect(partitionAssistantTurn(items).shouldFold).toBe(false);
  });

  it('finalOutput 之后的异常过程仍放 final 区可见', () => {
    const items = [
      group('g1', [tool('t1')]),
      text('final', '结论', { finalOutput: true }),
      group('late', [tool('t-late')]),
    ];
    const partition = partitionAssistantTurn(items);
    expect(partition.final.map((item) => item.id)).toEqual(['final', 'late']);
    expect(partition.shouldFold).toBe(true);
  });

  it('外部写操作计入摘要「写了 N 项」', () => {
    const items = [
      group('g1', [
        tool('read', { toolName: 'Read' }),
        tool('write', {
          toolName: 'DwsBusiness',
          durationMs: 2000,
          presentation: { title: '钉钉 · 创建待办', connector: { system: '钉钉', write: true } },
        }),
      ]),
      text('final', '完成', { finalOutput: true }),
    ];
    const partition = partitionAssistantTurn(items);
    expect(selectTurnProcessSummary(partition.process)).toMatchObject({
      title: '过程记录',
      subtitle: '1 项 · 2.0s · 写了 1 项',
      writeCount: 1,
    });
  });
});
