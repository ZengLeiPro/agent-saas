import { describe, expect, it } from 'vitest';
import { groupMessages, type MessageItem } from '@agent/shared';
import { anchorBusinessStepPlans } from './anchorBusinessStepPlans';
import { businessStepMainItems } from './BusinessStepTimeline';
import type { RenderItem } from './types';

type Step = Extract<RenderItem, { type: 'business_step' }>;
type User = Extract<RenderItem, { type: 'user' }>;
const plan = (id = 'plan', runId = 'run-1'): Step => ({
  type: 'business_step', id, kind: 'plan', anchorMessageId: `todo-${id}`, runId,
  todos: [{ id: 'step', kind: 'business', content: '核验 PR', status: 'in_progress' }],
});
const user = (id: string, status?: User['status']): User => ({
  type: 'user', id, content: id, status,
});
const section = (id: string, runId = 'run-1', isCurrent = false): RenderItem => ({
  type: 'business_step_section', id, isActive: isCurrent,
  start: {
    type: 'business_step', id: `start-${id}`, anchorMessageId: `todo-${id}`,
    runId, kind: 'start', isCurrent,
  },
  items: [{ type: 'text', id: `process-${id}`, content: '步骤内的过程正文', runId }],
});
const ids = (items: RenderItem[]) => businessStepMainItems(items).map((item) => item.id);

function snapshot(id: string, status: 'in_progress' | 'completed', runId = 'run-1'): MessageItem {
  return {
    type: 'tool_use', id, toolId: id, toolName: 'TodoWrite', runId, resultReady: true,
    toolInput: JSON.stringify({ todos: [
      { id: 'step', kind: 'business', content: '核验 PR', status },
    ] }),
  };
}

describe('业务步骤计划卡跟随插话（仅 Web 展示顺序）', () => {
  it.each([undefined, 'pending', 'sent'] as const)('发送 %s 插话后立即移动，无需等待新事件', (status) => {
    expect(ids([user('request'), plan(), section('active', 'run-1', true), user('aside', status)]))
      .toEqual(['request', 'aside', 'plan']);
  });

  it('连续插话只保留一张卡，跟随最新一条', () => {
    expect(ids([plan(), section('active', 'run-1', true), user('first'), user('second')]))
      .toEqual(['first', 'second', 'plan']);
  });

  it.each(['queued', 'failed'] as const)('%s 消息不移动计划卡，也不阻止跟随上一条有效插话', (status) => {
    expect(ids([plan(), section('active', 'run-1', true), user('ignored', status)]))
      .toEqual(['plan', 'ignored']);
    expect(ids([plan(), section('active', 'run-1', true), user('sent'), user('ignored', status)]))
      .toEqual(['sent', 'plan', 'ignored']);
  });

  it('只跟随已发送的语音，不跟随上传/转写/失败的语音草稿', () => {
    for (const status of ['uploading', 'transcribing', 'ready', 'failed', 'sent'] as const) {
      const voice: RenderItem = { type: 'user-voice', id: 'voice', audioUrl: '/audio', duration: 1, status };
      expect(ids([plan(), section('active', 'run-1', true), voice]))
        .toEqual(status === 'sent' ? ['voice', 'plan'] : ['plan', 'voice']);
    }
  });

  it('已完成/已关闭的历史计划仍依据同 Run 后续过程定位，不因 loading 结束而跳回去', () => {
    const completed: Step = { ...plan(), isClosed: true, todos: [
      { id: 'step', kind: 'business', content: '核验 PR', status: 'completed' },
    ] };
    expect(ids([completed, section('before'), user('aside'), section('after')]))
      .toEqual(['aside', 'plan']);
    expect(ids([completed, user('new-task')])).toEqual(['plan', 'new-task']);
  });

  it('同 Run 的工具活动足以确认归属，不要求 Agent 回复或再写 TodoWrite', () => {
    const activity: RenderItem = {
      type: 'activity_group', id: 'activity', isActive: false,
      items: [{ type: 'tool_use', id: 'read', toolId: 'read', toolName: 'Read', toolInput: '{}', runId: 'run-1' }],
    };
    expect(ids([{ ...plan(), isClosed: true }, user('aside'), activity]))
      .toEqual(['aside', 'plan', 'activity']);
  });

  it('另一个 Run 即使没有业务计划，也不会接走旧卡', () => {
    const newRun: RenderItem = { type: 'text', id: 'new-answer', content: '新的回复', runId: 'run-2' };
    expect(ids([plan(), section('active', 'run-1', true), user('new-task'), newRun]))
      .toEqual(['plan', 'new-task', 'new-answer']);
  });

  it.each([
    { type: 'text', id: 'end', content: '最终总结', finalOutput: true },
    { type: 'system-error', id: 'end', content: '任务已停止' },
    { type: 'system_event', id: 'end', title: '任务结束', content: '任务已停止' },
    { type: 'business_step', id: 'end', kind: 'reset', anchorMessageId: 'reset' },
  ] as RenderItem[])('不越过 $type 结束边界追随下一个任务', (boundary) => {
    const projected = businessStepMainItems([plan(), section('active', 'run-1', true), boundary, user('next')]);
    expect(projected[0].id).toBe('plan');
    expect(projected.at(-1)?.id).toBe('next');
  });

  it('多个 Run、同 Run reset 后的新计划分别归属，不拖走旧卡', () => {
    const reset: Step = { ...plan(), id: 'reset', kind: 'reset' };
    expect(ids([
      plan(), user('first'), section('confirmed'), reset,
      plan('new-plan'), section('new-active', 'run-1', true), user('second'), section('new-confirmed'),
      plan('other-plan', 'run-2'), section('other-active', 'run-2', true), user('third'),
    ])).toEqual(['first', 'plan', 'second', 'new-plan', 'third', 'other-plan']);
  });

  it('移动的是原卡对象：原数组、section 过程、ID 和详情锚点不变', () => {
    const card = Object.freeze(plan());
    const process = section('active', 'run-1', true);
    const aside = Object.freeze(user('aside'));
    const source = [card, process, aside];
    const before = JSON.stringify(source);
    Object.freeze(source);
    const result = businessStepMainItems(source);
    expect(result).toEqual([aside, card]);
    expect(result[1]).toBe(card);
    expect(JSON.stringify(source)).toBe(before);
    expect(businessStepMainItems(result)).toEqual(result);
  });

  it('门禁、排队消息与交付物仍可见；插话后的步骤正文仍只存在于详情', () => {
    const gate: RenderItem = {
      type: 'permission_request', id: 'gate', interactionId: 'permission', toolName: 'Write',
      toolInput: '{}', status: 'pending',
    };
    const after = section('after', 'run-1', true);
    if (after.type !== 'business_step_section') throw new Error('section fixture');
    after.items.push(gate, user('queued', 'queued'));
    const artifact: RenderItem = {
      type: 'file_download', id: 'artifact', artifactId: 'artifact', fileName: '结果.txt',
      fileType: 'txt', filePath: 'result.txt', fileSize: 1,
    };
    expect(ids([plan(), user('aside'), after, artifact]))
      .toEqual(['aside', 'plan', 'gate', 'queued', 'artifact']);
  });

  it('找不到可见的插话落点时保留原卡，不让计划消失', () => {
    const card = plan();
    expect(anchorBusinessStepPlans([card, section('active', 'run-1', true), user('hidden')], [card]))
      .toEqual([card]);
  });

  it.each([false, true])('真实 groupMessages 链路：发送、推进、完成、重放、历史前插（debug=%s）', (debugMode) => {
    const start: MessageItem[] = [user('request'), snapshot('start', 'in_progress')];
    const aside = user('aside', 'sent');
    const render = (messages: MessageItem[], loading: boolean) =>
      businessStepMainItems(groupMessages(messages, loading, { sectioning: true, debugMode }));
    const pending = render([...start, aside], true);
    const originalPlan = pending.find((item) => item.type === 'business_step');
    expect(pending.findIndex((item) => item.id === originalPlan?.id))
      .toBeGreaterThan(pending.findIndex((item) => item.id === aside.id));

    const completed: MessageItem[] = [
      ...start, aside,
      { type: 'text', id: 'process', content: '继续检查 CI', runId: 'run-1' },
      snapshot('complete', 'completed'),
      { type: 'text', id: 'final', content: '核验完成', runId: 'run-1', finalOutput: true },
    ];
    for (const messages of [completed, [user('older-history'), ...completed]]) {
      const replay = render(messages, false);
      expect(replay.filter((item) => item.type === 'business_step')).toHaveLength(1);
      expect(replay.find((item) => item.type === 'business_step')?.id).toBe(originalPlan?.id);
      const userIndex = replay.findIndex((item) => item.id === aside.id);
      expect(replay[userIndex + 1].id).toBe(originalPlan?.id);
      expect(replay.some((item) => item.id === 'process')).toBe(false);
      expect(replay.at(-1)?.id).toBe('final');
    }
  });
});
