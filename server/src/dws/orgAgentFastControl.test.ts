import { describe, expect, it, vi } from 'vitest';

import { executeFastControl, parseOrgAgentFastControl } from './orgAgentFastControl.js';

describe('DWS org Agent fast control', () => {
  it.each([
    ['状态 W-ABCDEF123456', { taskId: 'W-ABCDEF123456', action: 'status' }],
    ['W-abcdef123456 取消', { taskId: 'W-ABCDEF123456', action: 'cancel' }],
    ['pause W-ABCDEF123456', { taskId: 'W-ABCDEF123456', action: 'pause' }],
    ['W-ABCDEF123456 恢复', { taskId: 'W-ABCDEF123456', action: 'resume' }],
    [
      '补充 W-ABCDEF123456 请增加风险清单',
      {
        taskId: 'W-ABCDEF123456',
        action: 'amend',
        text: '请增加风险清单',
      },
    ],
    ['取消这个任务', { action: 'cancel' }],
    ['暂停当前任务', { action: 'pause' }],
    ['恢复任务', { action: 'resume' }],
    ['查看这个任务进度', { action: 'status' }],
    ['当前任务状态', { action: 'status' }],
  ])('解析显式短号或上下文控制：%s', (content, expected) => {
    expect(parseOrgAgentFastControl(content)).toEqual(expected);
  });

  it.each([
    '取消这个任务并通知我',
    '补充这个任务',
    '继续 W-不是短号',
    'W-ABCDEF123456',
    '补充 W-ABCDEF123456',
    'status W-ABCDEF123456 多余文本',
    '请帮我看看 W-ABCDEF123456 的状态',
  ])('普通或含糊文本不进入控制通道：%s', (content) => {
    expect(parseOrgAgentFastControl(content)).toBeNull();
  });

  it('控制复用现有 runtime，先解析当前任务再执行 mutation', async () => {
    const get = vi.fn(async () => ({ status: 'running' }));
    const controlWorkOrder = vi.fn(async () => ({
      task: null,
      workOrder: { shortId: 'W-ABCDEF123456', state: 'queued' },
    }));
    const context = {} as never;
    const text = await executeFastControl({
      runtime: { get, cancel: vi.fn(), controlWorkOrder } as never,
      context,
      request: { taskId: 'W-ABCDEF123456', action: 'amend', text: '补充' },
    });
    expect(get).toHaveBeenCalledWith(context, 'W-ABCDEF123456');
    expect(controlWorkOrder).toHaveBeenCalledWith(context, {
      taskId: 'W-ABCDEF123456',
      action: 'amend',
      text: '补充',
    });
    expect(text).toContain('补充要求');
  });
});
