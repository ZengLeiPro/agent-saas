/**
 * groupMessages.ts 测试
 *
 * 把扁平消息数组分组为 activity_group（连续的 thinking/tool_use/subagent/runtime_status）
 * 与非活动消息（user/text 等）。同时校验 isActive 计算：
 * - 组内有 streaming / running subagent → active
 * - 最后一组 + loading 且工具未 resultReady → active
 * - 非最后一组即使 loading 也不 active
 */
import { describe, expect, it } from 'vitest';
import { groupMessages } from './groupMessages';
import type { MessageItem, ActivityGroup, BusinessTodoGroup } from '../types/message';

const user = (id: string): MessageItem => ({ id, type: 'user', content: 'hi' });
const text = (id: string): MessageItem => ({ id, type: 'text', content: 'answer' });
const tool = (id: string, extra: Partial<Extract<MessageItem, { type: 'tool_use' }>> = {}): MessageItem => ({
  id, type: 'tool_use', toolName: 'Bash', toolInput: '{}', toolId: id, ...extra,
});
const thinking = (id: string, streaming = false): MessageItem => ({ id, type: 'thinking', content: 't', streaming });

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

  it('Business TodoWrite 在首次位置投影成一张主流卡，后续快照只更新不追加', () => {
    const start: MessageItem = {
      id: 'todo-start',
      type: 'tool_use',
      toolName: 'TodoWrite',
      toolId: 'todo-start',
      toolInput: JSON.stringify({
        todos: [{ id: 'verify', kind: 'business', content: '核验订单', status: 'in_progress' }],
      }),
    };
    const update: MessageItem = {
      id: 'todo-update',
      type: 'tool_use',
      toolName: 'TodoWrite',
      toolId: 'todo-update',
      toolInput: JSON.stringify({
        todos: [{ id: 'verify', kind: 'business', content: '核验订单', status: 'completed' }],
      }),
    };
    const read = tool('read-1', {
      toolName: 'Read',
      executionStatus: 'completed',
      presentation: { title: '读取订单' },
    });

    const result = groupMessages([user('user-1'), start, read, update, text('answer')], false);

    expect(result.map(item => item.type)).toEqual(['user', 'business_todo', 'text']);
    const business = result[1] as BusinessTodoGroup;
    expect(business.id).toBe('business-todo-todo-start');
    expect(business.todos).toMatchObject([{ id: 'verify', status: 'completed' }]);
    expect(business.activitiesByTodo['id:verify']).toMatchObject([
      { id: 'read-1', toolName: 'Read', label: '读取订单', status: 'completed' },
    ]);
    expect(business.toolMessagesByTodo['id:verify'].map(item => item.id)).toEqual(['read-1']);
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
