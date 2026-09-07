import { describe, expect, it } from 'vitest';

import type { TodoItem } from './extractTodos';
import {
  businessStepOverallStatus,
  businessStepResultPlaceholder,
  isEndedWithoutTerminal,
  outcomeToneMeta,
  todoAccessibleStatus,
  todoStatusMeta,
} from './businessStepStatus';

function todo(patch: Partial<TodoItem>): TodoItem {
  return { content: '步骤', status: 'pending', ...patch };
}

describe('todoStatusMeta', () => {
  it('已完成但业务结果失败时判为「完成结果异常」，绿勾不允许掩盖失败', () => {
    expect(
      todoStatusMeta(todo({ status: 'completed', outcome: { text: 'x', tone: 'fail' } })),
    ).toEqual({ label: '完成结果异常', tone: 'danger', icon: 'x', spin: false });
  });

  it('六种状态各有标签 / 语气 / 图标；仅进行中旋转', () => {
    expect(todoStatusMeta(todo({ status: 'in_progress' }))).toEqual({
      label: '进行中',
      tone: 'active',
      icon: 'progress',
      spin: true,
    });
    expect(todoStatusMeta(todo({ status: 'waiting' })).label).toBe('等待中');
    expect(todoStatusMeta(todo({ status: 'blocked' })).tone).toBe('danger');
    expect(todoStatusMeta(todo({ status: 'completed' })).tone).toBe('success');
    expect(todoStatusMeta(todo({ status: 'failed' })).icon).toBe('x');
    expect(todoStatusMeta(todo({ status: 'pending' })).label).toBe('待执行');
  });
});

describe('businessStepOverallStatus', () => {
  it('优先级：运行中 > 已阻断 > 有失败 > 等待中 > 已完成', () => {
    const todos = [todo({ status: 'in_progress' }), todo({ status: 'blocked' })];
    expect(businessStepOverallStatus(todos)).toEqual({
      completed: 0,
      label: '运行中',
      tone: 'active',
    });
    expect(businessStepOverallStatus(todos, true).label).toBe('已阻断');
    expect(businessStepOverallStatus([todo({ status: 'failed' })]).label).toBe('有失败');
    expect(businessStepOverallStatus([todo({ status: 'waiting' })]).label).toBe('等待中');
  });

  it('全部完成给「已完成」；计划已关且未完成给「已结束」；否则「待处理」', () => {
    expect(businessStepOverallStatus([todo({ status: 'completed' })])).toEqual({
      completed: 1,
      label: '已完成',
      tone: 'success',
    });
    expect(businessStepOverallStatus([todo({ status: 'pending' })], true).label).toBe('已结束');
    expect(businessStepOverallStatus([todo({ status: 'pending' })]).label).toBe('待处理');
    expect(businessStepOverallStatus([]).label).toBe('待处理');
  });
});

describe('outcomeToneMeta / isEndedWithoutTerminal / todoAccessibleStatus', () => {
  it('ok 结果不加图标，warn / fail 上语义色与图标', () => {
    expect(outcomeToneMeta({ text: 'a' })).toEqual({ tone: 'neutral', icon: null });
    expect(outcomeToneMeta({ text: 'a', tone: 'warn' })).toEqual({
      tone: 'warning',
      icon: 'alert',
    });
    expect(outcomeToneMeta({ text: 'a', tone: 'fail' })).toEqual({ tone: 'danger', icon: 'x' });
    expect(outcomeToneMeta(undefined).icon).toBeNull();
  });

  it('计划已结束而步骤仍停在进行中时按「已结束」朗读，不继续转圈', () => {
    const running = todo({ status: 'in_progress' });
    expect(isEndedWithoutTerminal(running, true)).toBe(true);
    expect(todoAccessibleStatus(running, true)).toBe('已结束');
    expect(todoAccessibleStatus(running, false)).toBe('进行中');
    expect(todoStatusMeta(running, true)).toEqual({ label: '已结束', tone: 'neutral', icon: 'circle', spin: false });
    expect(running.status).toBe('in_progress');
  });
});

describe('缺少结构化结果时的状态说明', () => {
  it('区分待执行、执行中和已有过程，不推断业务结果', () => {
    expect(businessStepResultPlaceholder(todo({}))).toBe('待执行');
    expect(businessStepResultPlaceholder(todo({}), false, true)).toBe('已有过程记录，步骤状态待更新');
    expect(businessStepResultPlaceholder(todo({ status: 'in_progress', activeForm: '核验订单' }))).toBe('核验订单');
    expect(businessStepResultPlaceholder(todo({ status: 'in_progress' }), false, true)).toBe('已有过程记录，尚未形成结论');
  });

  it('运行结束不会把未知状态变成完成，等待也不会被推断为人工确认', () => {
    expect(businessStepResultPlaceholder(todo({ status: 'in_progress' }), true)).toBe('本轮执行已结束，步骤状态未更新');
    expect(businessStepResultPlaceholder(todo({ status: 'waiting' }), true)).toBe('等待中，尚未提供等待原因');
    expect(todoStatusMeta(todo({ status: 'waiting' }), true).label).toBe('等待中');
    expect(businessStepResultPlaceholder(todo({ status: 'completed' }))).toBe('已完成，未提供步骤摘要');
    expect(businessStepResultPlaceholder(todo({ status: 'blocked' }))).toBe('执行受阻，尚未提供原因');
    expect(businessStepResultPlaceholder(todo({ status: 'failed' }))).toBe('执行失败，尚未提供结果说明');
  });
});
