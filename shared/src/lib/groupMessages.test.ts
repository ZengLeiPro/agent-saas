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
 * - TodoWrite 原始工具块在非 debug 视图隐藏，debug 保留。
 */
import { describe, expect, it } from 'vitest';
import { groupMessages } from './groupMessages';
import type { BusinessStepEventItem } from './extractTodos';
import type { MessageItem, ActivityGroup, BusinessStepSection } from '../types/message';

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

  it('非 debug 下 defaultExpanded + presentation 仍进入活动分组，不能绕过固定状态', () => {
    const hero = tool('hero', {
      presentation: { title: '写入 CRM 商机' },
      defaultExpanded: true,
    });
    const result = groupMessages([thinking('t1'), hero, tool('after')], false, { debugMode: false });
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('activity_group');
    expect((result[0] as ActivityGroup).items.map(i => i.id)).toEqual(['t1', 'hero', 'after']);
  });

  it('debug 下 defaultExpanded + presentation 的工具行仍独立成行', () => {
    const hero = tool('hero', {
      presentation: { title: '写入 CRM 商机' },
      defaultExpanded: true,
    });
    const result = groupMessages([thinking('t1'), hero, tool('after')], false, { debugMode: true });
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

  it('Business TodoWrite 差分成时间线事件：plan+start 在首快照位置，终态事件在后续快照位置', () => {
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

    // 扁平事件流（非 sectioning）：plan+start（首快照位置）→ 工具活动组（不被吸收）→ complete → 正文
    expect(result.map(item => item.type)).toEqual([
      'user', 'business_step', 'business_step', 'activity_group', 'business_step', 'text',
    ]);
    const plan = result[1] as BusinessStepEventItem;
    expect(plan).toMatchObject({ kind: 'plan', anchorMessageId: 'todo-start' });
    expect(result[2]).toMatchObject({ kind: 'start' });
    const activity = result[3] as ActivityGroup;
    expect(activity.items.map(i => i.id)).toEqual(['read-1']);
    const complete = result[4] as BusinessStepEventItem;
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
    expect(normal.map(item => item.type)).toEqual(['business_step', 'business_step']);

    const debug = groupMessages([snapshot], false, { debugMode: true });
    expect(debug.map(item => item.type)).toEqual(['business_step', 'business_step', 'activity_group']);
    expect((debug[2] as ActivityGroup).items.map(i => i.id)).toEqual(['todo-1']);
  });

  it('历史 task-only TodoWrite 不产生业务事件，非 debug 视图隐藏原始块', () => {
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
    expect(result.map(item => item.type)).toEqual([
      'activity_group', 'business_step', 'business_step', 'activity_group',
    ]);
    expect((result[0] as ActivityGroup).items.map(i => i.id)).toEqual(['t1']);
    expect((result[3] as ActivityGroup).items.map(i => i.id)).toEqual(['t2', 'shell-1']);
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

describe('groupMessages sectioning（章节化）', () => {
  const opts = { sectioning: true };
  const twoStepPlan = () => businessTodo('todo-plan', [
    { id: 'verify', kind: 'business', content: '核验订单', status: 'in_progress' },
    { id: 'write', kind: 'business', content: '写入结果', status: 'pending' },
  ]);
  const finishFirstStartSecond = () => businessTodo('todo-next', [
    {
      id: 'verify', kind: 'business', content: '核验订单', status: 'completed',
      outcome: { text: '17/18 张通过，1 张退回', tone: 'warn' },
    },
    { id: 'write', kind: 'business', content: '写入结果', status: 'in_progress' },
  ]);

  it('start→终态之间的内容按原时间顺序收编进步骤节，内容不搬运', () => {
    const result = groupMessages([
      user('user-1'),
      twoStepPlan(),
      thinking('th-1'),
      tool('read-1', { toolName: 'Read', executionStatus: 'completed' }),
      text('step1-note'),
      finishFirstStartSecond(),
      tool('shell-1', { toolName: 'Shell' }),
      text('final-answer'),
    ], false, opts);

    // plan 在顶层；第 1 步节含（活动组+text），带 terminal；第 2 步节开放，含后续活动组与 text。
    expect(result.map(item => item.type)).toEqual([
      'user', 'business_step', 'business_step_section', 'business_step_section',
    ]);
    const section1 = result[2] as BusinessStepSection;
    expect(section1.start).toMatchObject({ kind: 'start', todo: { id: 'verify' } });
    expect(section1.terminal).toMatchObject({
      kind: 'complete',
      todo: { id: 'verify', outcome: { text: '17/18 张通过，1 张退回', tone: 'warn' } },
    });
    expect(section1.items.map(item => item.type)).toEqual(['activity_group', 'text']);
    expect((section1.items[0] as ActivityGroup).items.map(i => i.id)).toEqual(['th-1', 'read-1']);

    const section2 = result[3] as BusinessStepSection;
    expect(section2.start).toMatchObject({ kind: 'start', todo: { id: 'write' } });
    expect(section2.terminal).toBeUndefined();
    expect(section2.items.map(item => item.type)).toEqual(['activity_group', 'text']);
  });

  it('开放节只有在流末尾且 run 活跃时才是 isActive', () => {
    const messages = [
      user('user-1'),
      twoStepPlan(),
      tool('read-1', { toolName: 'Read' }),
    ];
    const active = groupMessages(messages, true, opts);
    const openSection = active.at(-1) as BusinessStepSection;
    expect(openSection.type).toBe('business_step_section');
    expect(openSection.isActive).toBe(true);

    const idle = groupMessages(messages, false, opts);
    expect((idle.at(-1) as BusinessStepSection).isActive).toBe(false);
  });

  it('用户消息封闭开放节（被打断的节 isActive=false）', () => {
    const result = groupMessages([
      user('user-1'),
      twoStepPlan(),
      tool('read-1', { toolName: 'Read' }),
      user('user-2'),
    ], true, opts);

    expect(result.map(item => item.type)).toEqual([
      'user', 'business_step', 'business_step_section', 'user',
    ]);
    expect((result[2] as BusinessStepSection).isActive).toBe(false);
  });

  it('终态封节后的内容留在节外（最终总结不被折进步骤）', () => {
    const result = groupMessages([
      user('user-1'),
      businessTodo('todo-1', [
        { id: 'only', kind: 'business', content: '唯一步骤', status: 'in_progress' },
      ]),
      tool('read-1', { toolName: 'Read' }),
      businessTodo('todo-2', [
        { id: 'only', kind: 'business', content: '唯一步骤', status: 'completed' },
      ]),
      text('final-summary'),
    ], false, opts);

    expect(result.map(item => item.type)).toEqual([
      'user', 'business_step', 'business_step_section', 'text',
    ]);
    const section = result[2] as BusinessStepSection;
    expect(section.terminal).toMatchObject({ kind: 'complete' });
    expect(section.items.map(item => item.type)).toEqual(['activity_group']);
  });

  it('没有对应开放节的终态事件独立渲染（不吞其他步骤的节）', () => {
    // waiting 步骤恢复前，另一个步骤被直接标完成：complete 与开放节 key 不匹配。
    const result = groupMessages([
      businessTodo('t1', [
        { id: 'a', kind: 'business', content: 'A', status: 'in_progress' },
        { id: 'b', kind: 'business', content: 'B', status: 'pending' },
      ]),
      businessTodo('t2', [
        { id: 'a', kind: 'business', content: 'A', status: 'in_progress' },
        { id: 'b', kind: 'business', content: 'B', status: 'completed' },
      ]),
    ], false, opts);

    // b 的 complete 没有自己的节：A 节被封（无 terminal），complete 独立出现。
    const types = result.map(item => item.type);
    expect(types).toEqual(['business_step', 'business_step_section', 'business_step']);
    expect((result[1] as BusinessStepSection).terminal).toBeUndefined();
    expect(result[2]).toMatchObject({ kind: 'complete', todo: { id: 'b' } });
  });

  it('sectioning 关闭时保持扁平事件流（mobile 兼容）', () => {
    const result = groupMessages([
      user('user-1'),
      twoStepPlan(),
      tool('read-1', { toolName: 'Read' }),
      finishFirstStartSecond(),
    ], false);

    expect(result.every(item => item.type !== 'business_step_section')).toBe(true);
  });
});

describe('groupMessages 跨层矛盾角标（processAnomaly）', () => {
  const opts = { sectioning: true };
  const startPlan = () => businessTodo('todo-plan', [
    { id: 'sync', kind: 'business', content: '同步钉钉待办', status: 'in_progress' },
  ]);
  const completeWith = (outcome?: Record<string, unknown>) => businessTodo('todo-done', [
    {
      id: 'sync', kind: 'business', content: '同步钉钉待办', status: 'completed',
      ...(outcome ? { outcome } : {}),
    },
  ]);
  const dwsTool = (id: string, status: 'ok' | 'warn') => tool(id, {
    toolName: 'Shell',
    presentation: { title: '钉钉 · 创建待办', status },
  });

  it('失败→重试成功→outcome ok：同类最后一次成功，不标（防误伤正常重试）', () => {
    const result = groupMessages([
      user('u'), startPlan(),
      dwsTool('call-1', 'warn'),
      dwsTool('call-2', 'ok'),
      completeWith({ text: '已创建', tone: 'ok' }),
    ], false, opts);
    const section = result.at(-1) as BusinessStepSection;
    expect(section.type).toBe('business_step_section');
    expect(section.terminal?.kind).toBe('complete');
    expect(section.processAnomaly).toBeUndefined();
  });

  it('最终失败→outcome ok：同类最后一次仍失败，标「过程有异常」', () => {
    const result = groupMessages([
      user('u'), startPlan(),
      dwsTool('call-1', 'ok'),
      dwsTool('call-2', 'warn'),
      completeWith({ text: '已创建', tone: 'ok' }),
    ], false, opts);
    const section = result.at(-1) as BusinessStepSection;
    expect(section.terminal?.kind).toBe('complete');
    expect(section.processAnomaly).toBe(true);
  });

  it('completed 无 outcome（缺省干净绿）时最后一次失败同样标', () => {
    const result = groupMessages([
      user('u'), startPlan(),
      dwsTool('call-1', 'warn'),
      completeWith(),
    ], false, opts);
    expect((result.at(-1) as BusinessStepSection).processAnomaly).toBe(true);
  });

  it('模型已自认 warn/fail 时不重复标', () => {
    const result = groupMessages([
      user('u'), startPlan(),
      dwsTool('call-1', 'warn'),
      completeWith({ text: '部分失败', tone: 'warn' }),
    ], false, opts);
    expect((result.at(-1) as BusinessStepSection).processAnomaly).toBeUndefined();
  });

  it('不同类操作独立分组：A 类最后一次失败即命中，不被 B 类成功洗白', () => {
    const result = groupMessages([
      user('u'), startPlan(),
      dwsTool('call-1', 'warn'),
      tool('read-1', { toolName: 'Read', presentation: { title: '读取 result.md', status: 'ok' } }),
      completeWith({ text: '已创建', tone: 'ok' }),
    ], false, opts);
    expect((result.at(-1) as BusinessStepSection).processAnomaly).toBe(true);
  });

  it('无 presentation.status 的调用不参与判定（宁缺毋滥）', () => {
    const result = groupMessages([
      user('u'), startPlan(),
      tool('bare-1'),
      completeWith({ text: '已创建', tone: 'ok' }),
    ], false, opts);
    expect((result.at(-1) as BusinessStepSection).processAnomaly).toBeUndefined();
  });

  it('非 complete 终态（blocked）不标——失败已有自己的语义色', () => {
    const result = groupMessages([
      user('u'), startPlan(),
      dwsTool('call-1', 'warn'),
      businessTodo('todo-block', [
        { id: 'sync', kind: 'business', content: '同步钉钉待办', status: 'blocked',
          outcome: { text: '未创建', tone: 'fail' } },
      ]),
    ], false, opts);
    const section = result.at(-1) as BusinessStepSection;
    expect(section.terminal?.kind).toBe('block');
    expect(section.processAnomaly).toBeUndefined();
  });
});
