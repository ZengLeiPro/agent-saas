import { describe, expect, it } from 'vitest';

import type { TodoItem } from './extractTodos';
import {
  businessStepOverallStatus,
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
    expect(todoStatusMeta(todo({ status: 'pending' })).label).toBe('待处理');
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
  });
});
