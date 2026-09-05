import { describe, expect, it } from 'vitest';
import type { CronJob, CronRunLogEntry } from '../types/cron';
import {
  CRON_DINGTALK_MODE_OPTIONS,
  CRON_EXPR_PRESETS,
  CRON_NOTIFY_CHANNEL_OPTIONS,
  cronJobStatusLabel,
  cronJobStatusTone,
  cronJobSubtitle,
  cronNotifyNeedsDingtalk,
  cronRunStatusLabel,
  cronRunStatusTone,
  cronRunSummary,
  cronRunTriggerLabel,
  formatCronNextRun,
  formatCronRunDuration,
  formatCronSchedule,
  isFiveFieldCronExpr,
  resolveCronModelLabel,
  sortCronJobsByNextRun,
} from './cronPresentation';

function job(partial: Partial<CronJob> & Pick<CronJob, 'id'>): CronJob {
  return {
    name: partial.id,
    enabled: true,
    schedule: { kind: 'every', everyMs: 60_000 },
    payload: { kind: 'agentTurn', message: 'hi' },
    createdAtMs: 0,
    updatedAtMs: 0,
    state: {},
    ...partial,
  } as CronJob;
}

describe('sortCronJobsByNextRun', () => {
  it('按下次运行时间升序，无下次运行的排最后，且不改原数组', () => {
    const input = [
      job({ id: 'c', state: {} }),
      job({ id: 'a', state: { nextRunAtMs: 100 } }),
      job({ id: 'b', state: { nextRunAtMs: 200 } }),
    ];
    expect(sortCronJobsByNextRun(input).map((j) => j.id)).toEqual(['a', 'b', 'c']);
    expect(input.map((j) => j.id)).toEqual(['c', 'a', 'b']);
  });
});

describe('formatCronSchedule', () => {
  it('间隔调度按分钟/小时/天收敛', () => {
    expect(formatCronSchedule({ kind: 'every', everyMs: 30 * 60_000 })).toBe('每 30 分钟');
    expect(formatCronSchedule({ kind: 'every', everyMs: 3 * 3600_000 })).toBe('每 3 小时');
    expect(formatCronSchedule({ kind: 'every', everyMs: 2 * 86_400_000 })).toBe('每 2 天');
    // 不足 1 分钟仍至少显示 1 分钟，不出现「每 0 分钟」
    expect(formatCronSchedule({ kind: 'every', everyMs: 1000 })).toBe('每 1 分钟');
  });

  it('cron 只显示表达式，一次性显示绝对时间', () => {
    expect(formatCronSchedule({ kind: 'cron', expr: '0 9 * * *', tz: 'UTC' })).toBe(
      'Cron 0 9 * * *',
    );
    const atMs = new Date(2026, 8, 5, 9, 30).getTime();
    expect(formatCronSchedule({ kind: 'at', atMs })).toBe('一次性 · 2026-09-05 09:30');
  });
});

describe('formatCronNextRun', () => {
  const now = new Date(2026, 8, 5, 12, 0).getTime();

  it('今天/明天/更远分别用不同前缀', () => {
    expect(formatCronNextRun(new Date(2026, 8, 5, 18, 5).getTime(), now)).toBe('今天 18:05');
    expect(formatCronNextRun(new Date(2026, 8, 6, 9, 0).getTime(), now)).toBe('明天 09:00');
    expect(formatCronNextRun(new Date(2026, 8, 9, 9, 0).getTime(), now)).toBe('9/9 09:00');
  });

  it('缺失下次运行返回占位符', () => {
    expect(formatCronNextRun(undefined, now)).toBe('-');
  });
});

describe('formatCronRunDuration', () => {
  it('保留一位小数秒，非法值回落占位符', () => {
    expect(formatCronRunDuration(800)).toBe('0.8s');
    expect(formatCronRunDuration(12_000)).toBe('12.0s');
    expect(formatCronRunDuration(undefined)).toBe('-');
    expect(formatCronRunDuration(-1)).toBe('-');
  });
});

describe('运行/任务状态语义', () => {
  it('运行记录状态映射到语义档与中文名', () => {
    expect(cronRunStatusTone('ok')).toBe('success');
    expect(cronRunStatusTone('error')).toBe('error');
    expect(cronRunStatusTone('skipped')).toBe('cancelled');
    expect(cronRunStatusLabel('ok')).toBe('成功');
    expect(cronRunStatusLabel('skipped')).toBe('跳过');
  });

  it('运行中优先于禁用，禁用优先于历史结果', () => {
    expect(
      cronJobStatusTone(job({ id: 'a', state: { runningAtMs: 1, lastStatus: 'error' } })),
    ).toBe('running');
    expect(cronJobStatusTone(job({ id: 'a', enabled: false, state: { lastStatus: 'ok' } }))).toBe(
      'cancelled',
    );
    expect(cronJobStatusTone(job({ id: 'a', state: { lastStatus: 'ok' } }))).toBe('success');
    expect(cronJobStatusTone(job({ id: 'a', state: { lastStatus: 'error' } }))).toBe('error');
    expect(cronJobStatusTone(job({ id: 'a', state: {} }))).toBe('pending');
    expect(cronJobStatusLabel(job({ id: 'a', enabled: false, state: {} }))).toBe('已停用');
    expect(cronJobStatusLabel(job({ id: 'a', state: {} }))).toBe('待运行');
  });

  it('触发方式与运行摘要', () => {
    expect(cronRunTriggerLabel('manual')).toBe('手动');
    expect(cronRunTriggerLabel('retry')).toBe('重试');
    expect(cronRunTriggerLabel(undefined)).toBe('定时');
    const base = {
      runId: 'r',
      jobId: 'j',
      jobName: 'n',
      startedAtMs: 0,
      endedAtMs: 0,
      durationMs: 0,
    };
    expect(cronRunSummary({ ...base, status: 'ok' } as CronRunLogEntry)).toBe('运行成功');
    expect(cronRunSummary({ ...base, status: 'skipped' } as CronRunLogEntry)).toBe('已跳过');
    expect(cronRunSummary({ ...base, status: 'error' } as CronRunLogEntry)).toBe('运行失败');
    expect(
      cronRunSummary({ ...base, status: 'error', error: 'x'.repeat(20) } as CronRunLogEntry, 5),
    ).toBe('xxxxx…');
  });
});

describe('resolveCronModelLabel / cronJobSubtitle', () => {
  const modelList = {
    groups: [{ id: 'g1', name: '分组', models: [{ id: 'm1', name: '模型甲' }] }],
  } as never;

  it('解析得到展示名，解析不到回落原始 ref', () => {
    expect(resolveCronModelLabel('g1/m1', modelList)).toBe('模型甲');
    expect(resolveCronModelLabel('g1/unknown', modelList)).toBe('g1/unknown');
    expect(resolveCronModelLabel('bare-ref', modelList)).toBe('bare-ref');
    expect(resolveCronModelLabel('g1/m1', null)).toBe('g1/m1');
  });

  it('副标题按「调度 · 下次 · 模型」拼接，缺项省略', () => {
    const now = new Date(2026, 8, 5, 12, 0).getTime();
    const withAll = job({
      id: 'a',
      schedule: { kind: 'every', everyMs: 30 * 60_000 },
      payload: { kind: 'agentTurn', message: 'hi', model: 'g1/m1' },
      state: { nextRunAtMs: new Date(2026, 8, 5, 18, 0).getTime() },
    });
    expect(cronJobSubtitle(withAll, { modelList, nowMs: now })).toBe(
      '每 30 分钟 · 下次 今天 18:00 · 模型甲',
    );

    const minimal = job({ id: 'b', payload: { kind: 'systemEvent', text: 'e' }, state: {} });
    expect(cronJobSubtitle(minimal, { nowMs: now })).toBe('每 1 分钟');
  });
});

describe('选项表与工具函数', () => {
  it('通知渠道选项与 Web 下拉一致', () => {
    expect(CRON_NOTIFY_CHANNEL_OPTIONS.map((o) => o.value)).toEqual(['web', 'dingtalk', 'both']);
    expect(CRON_DINGTALK_MODE_OPTIONS.map((o) => o.value)).toEqual(['session', 'user', 'chat']);
    expect(CRON_DINGTALK_MODE_OPTIONS.every((o) => !!o.hint)).toBe(true);
  });

  it('只有钉钉/两者渠道且开启通知才需要钉钉目标', () => {
    expect(cronNotifyNeedsDingtalk(true, 'dingtalk')).toBe(true);
    expect(cronNotifyNeedsDingtalk(true, 'both')).toBe(true);
    expect(cronNotifyNeedsDingtalk(true, 'web')).toBe(false);
    expect(cronNotifyNeedsDingtalk(false, 'dingtalk')).toBe(false);
  });

  it('全部 cron 预设都是合法的 5 字段表达式', () => {
    expect(CRON_EXPR_PRESETS.length).toBeGreaterThan(0);
    for (const preset of CRON_EXPR_PRESETS) {
      expect(isFiveFieldCronExpr(preset.value), preset.value).toBe(true);
    }
    expect(isFiveFieldCronExpr('0 9 * *')).toBe(false);
    expect(isFiveFieldCronExpr('  0   9 * * *  ')).toBe(true);
  });
});
