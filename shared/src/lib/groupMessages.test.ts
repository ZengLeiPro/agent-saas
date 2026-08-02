/**
 * groupMessages.ts 测试
 *
 * 把扁平消息数组分组为 activity_group（连续的 thinking/tool_use/subagent/runtime_status）
 * 与非活动消息（user/text 等）。同时校验 isActive 计算：
 * - 组内有 streaming / running subagent → active
 * - 最后一组 + loading 且工具未 resultReady → active
 * - 非最后一组即使 loading 也不 active
 *
 * Business TodoWrite 走「快照差分→事件流」投影：
 * - 事件插在产生它的 TodoWrite 消息位置，按时间线性出现；
 * - 普通工具调用不再被吸进步骤卡，保持自然活动分组；
 * - TodoWrite 消息非 debug 隐藏（总览由 TodoPanel 承载），debug 保留原始块。
 */
import { describe, expect, it } from 'vitest';
import { groupMessages } from './groupMessages';
import type { BusinessStepEventItem } from './extractTodos';
import type { MessageItem, ActivityGroup } from '../types/message';

const user = (id: string): MessageItem => ({ id, type: 'user', content: 'hi' });
const text = (id: string): MessageItem => ({ id, type: 'text', content: 'answer' });
const tool = (id: string, extra: Partial<Extract<MessageItem, { type: 'tool_use' }>> = {}): MessageItem => ({
  id, type: 'tool_use', toolName: 'Bash', toolInput: '{}', toolId: id, ...extra,
});
const thinking = (id: string, streaming = false): MessageItem => ({ id, type: 'thinking', content: 't', streaming });
const businessTodo = (id: string, items: Array<Record<string, unknown>>): MessageItem => ({
  id,
  type: 'tool_use',
  toolName: 'TodoWrite',
  toolId: id,
  toolInput: JSON.stringify({ todos: items }),
});

describe('groupMessages', () => {
  it('连续的活动消息聚合为一个 activity_group，id 取首个 item', () => {
    const result = groupMessages([thinking('t1'), tool('tool-1')], false);
    expect(result).toHaveLength(1);
    const group = result[0] as ActivityGroup;
    expect(group.type).toBe('activity_group');
    expect(group.id).toBe('ag-t1');
    expect(group.items.map(i => i.id)).toEqual(['t1', 'tool-1']);
  });

  it('非活动消息（user/text）打断分组，形成独立 render 单元', () => {
    const result = groupMessages([tool('a'), user('u1'), tool('b'), text('txt')], false);
    expect(result.map(r => r.type)).toEqual(['activity_group', 'user', 'activity_group', 'text']);
    expect((result[0] as ActivityGroup).items.map(i => i.id)).toEqual(['a']);
    expect((result[2] as ActivityGroup).items.map(i => i.id)).toEqual(['b']);
  });

  it('空数组返回空结果', () => {
    expect(groupMessages([], false)).toEqual([]);
  });

  it('defaultExpanded + presentation 的工具行独立成行，不进活动分组', () => {
    const hero = tool('hero', {
      presentation: { title: '写入 CRM 商机' },
      defaultExpanded: true,
    });
    const result = groupMessages([thinking('t1'), hero, tool('after')], false);
    expect(result.map(r => r.type)).toEqual(['activity_group', 'tool_use', 'activity_group']);
    expect((result[0] as ActivityGroup).items.map(i => i.id)).toEqual(['t1']);
    expect((result[1] as MessageItem).id).toBe('hero');
    expect((result[2] as ActivityGroup).items.map(i => i.id)).toEqual(['after']);
  });

  it('仅有 presentation（无 defaultExpanded）的工具行仍进活动分组——真实会话行为不变', () => {
    const covered = tool('covered', { presentation: { title: '读取文件' } });
    const result = groupMessages([thinking('t1'), covered], false);
    expect(result).toHaveLength(1);
    expect((result[0] as ActivityGroup).items.map(i => i.id)).toEqual(['t1', 'covered']);
  });

  it('仅有 defaultExpanded（无 presentation）的工具行仍进活动分组——原始 payload 不上主流', () => {
    const bare = tool('bare', { defaultExpanded: true });
    const result = groupMessages([thinking('t1'), bare], false);
    expect(result).toHaveLength(1);
    expect((result[0] as ActivityGroup).items.map(i => i.id)).toEqual(['t1', 'bare']);
  });

  it('Business TodoWrite 差分成时间线事件：plan 在首快照位置，终态事件在后续快照位置', () => {
    const start = businessTodo('todo-start', [
      { id: 'verify', kind: 'business', content: '核验订单', status: 'in_progress' },
    ]);
    const update = businessTodo('todo-update', [
      { id: 'verify', kind: 'business', content: '核验订单', status: 'completed', detail: ['核验通过'] },
    ]);
    const read = tool('read-1', {
      toolName: 'Read',
      executionStatus: 'completed',
      presentation: { title: '读取订单' },
    });

    const result = groupMessages([user('user-1'), start, read, update, text('answer')], false);

    // 事件按时间线出现：plan（首快照位置）→ 工具活动组（不被吸收）→ complete（终态快照位置）→ 正文
    expect(result.map(item => item.type)).toEqual([
      'user', 'business_step', 'activity_group', 'business_step', 'text',
    ]);
    const plan = result[1] as BusinessStepEventItem;
    expect(plan).toMatchObject({ kind: 'plan', anchorMessageId: 'todo-start' });
    const activity = result[2] as ActivityGroup;
    expect(activity.items.map(i => i.id)).toEqual(['read-1']);
    const complete = result[3] as BusinessStepEventItem;
    expect(complete).toMatchObject({
      kind: 'complete',
      anchorMessageId: 'todo-update',
      todo: { id: 'verify', status: 'completed', detail: ['核验通过'] },
    });
  });

  it('非 debug 视图隐藏 TodoWrite 原始块；debug 视图保留（与事件并存）', () => {
    const snapshot = businessTodo('todo-1', [
      { id: 'verify', kind: 'business', content: '核验订单', status: 'in_progress' },
    ]);

    const normal = groupMessages([snapshot], false);
    expect(normal.map(item => item.type)).toEqual(['business_step']);

    const debug = groupMessages([snapshot], false, { debugMode: true });
    expect(debug.map(item => item.type)).toEqual(['business_step', 'activity_group']);
    expect((debug[1] as ActivityGroup).items.map(i => i.id)).toEqual(['todo-1']);
  });

  it('task-only TodoWrite 从主流隐藏且不产生事件（总览由 TodoPanel 承载）', () => {
    const taskSnapshot = businessTodo('todo-task', [
      { id: 'task', kind: 'task', content: '普通任务', status: 'in_progress' },
    ]);
    const result = groupMessages([thinking('t1'), taskSnapshot, text('txt')], false);
    expect(result.map(item => item.type)).toEqual(['activity_group', 'text']);
    expect((result[0] as ActivityGroup).items.map(i => i.id)).toEqual(['t1']);
  });

  it('业务步骤事件切开前后的活动分组，普通工具保持自然顺序', () => {
    const snapshot = businessTodo('todo-1', [
      { id: 'a', kind: 'business', content: '第一步', status: 'in_progress' },
    ]);
    const result = groupMessages(
      [thinking('t1'), snapshot, thinking('t2'), tool('shell-1')],
      false,
    );
    expect(result.map(item => item.type)).toEqual(['activity_group', 'business_step', 'activity_group']);
    expect((result[0] as ActivityGroup).items.map(i => i.id)).toEqual(['t1']);
    expect((result[2] as ActivityGroup).items.map(i => i.id)).toEqual(['t2', 'shell-1']);
  });

  it('只有非活动消息时不产生任何 activity_group', () => {
    const result = groupMessages([user('u1'), text('t1')], false);
    expect(result).toEqual([
      { id: 'u1', type: 'user', content: 'hi' },
      { id: 't1', type: 'text', content: 'answer' },
    ]);
  });

  it('组内含 streaming thinking 时 isActive=true（即使非最后一组、loading=false）', () => {
    const result = groupMessages([thinking('t1', true), user('u1')], false);
    expect((result[0] as ActivityGroup).isActive).toBe(true);
  });

  it('组内含 running subagent 时 isActive=true', () => {
    const sub: MessageItem = { id: 's1', type: 'subagent', toolId: 's1', agentType: '子任务', status: 'running' };
    const result = groupMessages([sub, user('u1')], false);
    expect((result[0] as ActivityGroup).isActive).toBe(true);
  });

  it('最后一组 + loading 且工具未 resultReady 时 isActive=true', () => {
    const result = groupMessages([tool('a', { resultReady: false })], true);
    expect((result[0] as ActivityGroup).isActive).toBe(true);
  });

  it('非最后一组即使 loading 也不 active（无 streaming/running）', () => {
    const result = groupMessages([tool('a', { resultReady: true }), user('u1')], true);
    expect((result[0] as ActivityGroup).isActive).toBe(false);
  });

  it('最后一组 + loading=false 且无流式项时 isActive=false', () => {
    const result = groupMessages([tool('a', { resultReady: true })], false);
    expect((result[0] as ActivityGroup).isActive).toBe(false);
  });
});
