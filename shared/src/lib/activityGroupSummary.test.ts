import { describe, expect, it } from 'vitest';

import type { MessageItem } from '../types/message';
import { POLICY_REJECTION_FAILURE_MESSAGE } from './runtimeErrorMessage';
import {
  getActiveItemIndex,
  getActivityDurationMs,
  getCompletedGroupTitle,
  getRuntimeStatusLabel,
  getRuntimeStatusMeta,
  getRuntimeStatusTone,
  isActiveActivity,
  isWaitingForUserAction,
  selectActivityGroupSummary,
} from './activityGroupSummary';

function toolUse(patch: Partial<Extract<MessageItem, { type: 'tool_use' }>>): MessageItem {
  return {
    id: patch.id ?? 't1',
    type: 'tool_use',
    toolName: 'Bash',
    toolInput: '{}',
    toolId: 'tid',
    ...patch,
  } as MessageItem;
}

describe('getRuntimeStatusLabel / Meta / Tone', () => {
  it('分组折叠行用短标签（排队中/处理中/待处理/待补充）', () => {
    expect(getRuntimeStatusLabel('queued')).toBe('排队中');
    expect(getRuntimeStatusLabel('running')).toBe('处理中');
    expect(getRuntimeStatusLabel('waiting_approval')).toBe('待处理');
    expect(getRuntimeStatusLabel('waiting_user')).toBe('待补充');
    expect(getRuntimeStatusLabel('sending')).toBe('执行中');
  });

  it('独立状态行用完整标签 + 图标语义位', () => {
    expect(getRuntimeStatusMeta('waiting_hand')).toEqual({
      label: '正在准备工作区',
      icon: 'server',
    });
    expect(getRuntimeStatusMeta('queued')).toEqual({ label: '已进入队列', icon: 'clock' });
    expect(getRuntimeStatusMeta('running')).toEqual({ label: '正在思考', icon: 'loader' });
    expect(getRuntimeStatusMeta('waiting_approval')).toEqual({ label: '待处理', icon: 'shield' });
    expect(getRuntimeStatusMeta('waiting_user')).toEqual({ label: '待补充', icon: 'user' });
    expect(getRuntimeStatusMeta('reconnecting')).toEqual({ label: '正在恢复连接', icon: 'loader' });
    expect(getRuntimeStatusMeta('sending')).toEqual({ label: '正在发送消息', icon: 'loader' });
  });

  it('等待人工的状态是 warning，排队是 pending，其余 active', () => {
    expect(getRuntimeStatusTone('waiting_approval')).toBe('warning');
    expect(getRuntimeStatusTone('waiting_user')).toBe('warning');
    expect(getRuntimeStatusTone('queued')).toBe('pending');
    expect(getRuntimeStatusTone('running')).toBe('active');
  });
});

describe('isActiveActivity / isWaitingForUserAction / getActiveItemIndex', () => {
  it('tool_use 未出结果且非终态即视为进行中', () => {
    expect(isActiveActivity(toolUse({}))).toBe(true);
    expect(isActiveActivity(toolUse({ executionStatus: 'completed' }))).toBe(false);
    expect(isActiveActivity(toolUse({ resultReady: true }))).toBe(false);
    expect(isActiveActivity(toolUse({ executionStatus: 'running' }))).toBe(true);
  });

  it('等待人工的项优先于仍在跑的项', () => {
    const items: MessageItem[] = [
      { id: 'r', type: 'runtime_status', status: 'waiting_approval' },
      toolUse({ id: 't', executionStatus: 'running' }),
    ];
    expect(isWaitingForUserAction(items[0])).toBe(true);
    expect(getActiveItemIndex(items)).toBe(0);
  });

  it('没有活动项时返回 -1', () => {
    expect(getActiveItemIndex([toolUse({ executionStatus: 'completed' })])).toBe(-1);
  });
});

describe('getActivityDurationMs / getCompletedGroupTitle', () => {
  it('累加 thinking/tool_use/subagent 的耗时；全无耗时返回 undefined', () => {
    expect(
      getActivityDurationMs([
        toolUse({ id: 'a', durationMs: 1200, executionStatus: 'completed' }),
        { id: 'b', type: 'thinking', content: 'x', durationMs: 800 },
      ]),
    ).toBe(2000);
    expect(getActivityDurationMs([toolUse({ executionStatus: 'completed' })])).toBeUndefined();
  });

  it('完成标题去重、超长截断补「等」；无摘要时兜底「已运行」', () => {
    const titles = [
      '核对魏德米勒选型表',
      '写入脱敏副本快照',
      '回写钉钉审批单据',
      '同步客户主数据档案',
      '生成对账差异清单',
    ];
    const items = titles.map((title, i) =>
      toolUse({ id: `t${i}`, executionStatus: 'completed', presentation: { title } }),
    );
    const result = getCompletedGroupTitle([...items, items[0]]);
    expect(result.endsWith(' 等')).toBe(true);
    expect(result).toContain('核对魏德米勒选型表');
    expect(getCompletedGroupTitle([toolUse({ executionStatus: 'completed' })])).toBe('已运行');
  });
});

describe('selectActivityGroupSummary', () => {
  it('活动中给出进度位与 active 语气', () => {
    const summary = selectActivityGroupSummary(
      [toolUse({ id: 'a', executionStatus: 'completed' }), toolUse({ id: 'b' })],
      true,
    );
    expect(summary).toEqual({ text: '执行中', tone: 'active', progress: '2/2', active: true });
  });

  it('等待人工时不再转圈（active=false）且用 warning 语气', () => {
    const summary = selectActivityGroupSummary(
      [{ id: 'r', type: 'runtime_status', status: 'waiting_user' }],
      true,
    );
    expect(summary).toEqual({ text: '待补充', tone: 'warning', progress: '1/1', active: false });
  });

  it('policy_rejection 走与 Web 一致的特判文案', () => {
    const summary = selectActivityGroupSummary(
      [
        {
          id: 's',
          type: 'subagent',
          toolId: 'x',
          agentType: 'general',
          status: 'failed',
          failureKind: 'policy_rejection',
          recoveryAction: 'switch_model',
        } as MessageItem,
      ],
      false,
    );
    expect(summary.text).toBe(POLICY_REJECTION_FAILURE_MESSAGE);
    expect(summary.tone).toBe('danger');
  });

  it('已取消给出条数；完成态在非 debug 视图固定说「已运行」', () => {
    expect(
      selectActivityGroupSummary([toolUse({ executionStatus: 'cancelled' })], false).text,
    ).toBe('已取消 1 条 · 共 1 条');

    const done = [
      toolUse({
        executionStatus: 'completed',
        durationMs: 1500,
        presentation: { title: '核对报价' },
      }),
    ];
    expect(selectActivityGroupSummary(done, false)).toEqual({
      text: '已运行',
      tone: 'success',
      durationMs: 1500,
      active: false,
    });
    expect(selectActivityGroupSummary(done, false, true).text).toBe('核对报价');
  });
});
