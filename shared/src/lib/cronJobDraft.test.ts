import { describe, expect, it } from 'vitest';
import type { CronJob } from '../types/cron';
import {
  CRON_MODEL_DEFAULT_VALUE,
  buildCronJobCreate,
  cronJobToDraft,
  emptyCronJobDraft,
  isCronDraftDirty,
  validateCronDingtalkTarget,
} from './cronJobDraft';

const NOW = new Date(2026, 8, 5, 12, 0).getTime();

function baseJob(partial: Partial<CronJob> = {}): CronJob {
  return {
    id: 'job-1',
    name: '每日报告',
    description: '描述',
    enabled: true,
    schedule: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' },
    payload: {
      kind: 'agentTurn',
      message: '生成日报',
      model: 'g1/m1',
      maxTurns: 8,
      timeoutSeconds: 600,
      context: { persona: false },
    },
    notify: {
      enabled: true,
      channel: 'dingtalk',
      onSuccess: false,
      onError: true,
      dingtalk: { mode: 'user', userId: ['u1', 'u2'] },
    },
    createdAtMs: 0,
    updatedAtMs: 0,
    state: {},
    ...partial,
  } as CronJob;
}

describe('emptyCronJobDraft', () => {
  it('默认值与 Web JobForm 一致（间隔 60 分钟 / 超时 1800 / 上下文全开）', () => {
    const draft = emptyCronJobDraft(NOW);
    expect(draft.scheduleKind).toBe('every');
    expect(draft.everyMinutes).toBe(60);
    expect(draft.cronExpr).toBe('0 9 * * *');
    expect(draft.cronTz).toBe('Asia/Shanghai');
    expect(draft.timeoutSeconds).toBe('1800');
    expect(draft.model).toBe(CRON_MODEL_DEFAULT_VALUE);
    expect(draft.atMs).toBe(NOW + 3600_000);
    expect([draft.ctxSystemPrompt, draft.ctxPersona, draft.ctxMemory]).toEqual([true, true, true]);
    expect(draft.notifyEnabled).toBe(false);
    expect(draft.notifyChannel).toBe('web');
  });
});

describe('cronJobToDraft', () => {
  it('回填全部字段，userId 数组按逗号拼接', () => {
    const draft = cronJobToDraft(baseJob(), NOW);
    expect(draft.name).toBe('每日报告');
    expect(draft.scheduleKind).toBe('cron');
    expect(draft.cronExpr).toBe('0 9 * * *');
    expect(draft.model).toBe('g1/m1');
    expect(draft.maxTurns).toBe('8');
    expect(draft.timeoutSeconds).toBe('600');
    expect(draft.ctxPersona).toBe(false);
    expect(draft.ctxMemory).toBe(true);
    expect(draft.notifyChannel).toBe('dingtalk');
    expect(draft.notifyOnSuccess).toBe(false);
    expect(draft.dingtalkMode).toBe('user');
    expect(draft.dingtalkUserId).toBe('u1,u2');
  });

  it('间隔与一次性调度分别回填，systemEvent 用 text 填 message', () => {
    const every = cronJobToDraft(
      baseJob({ schedule: { kind: 'every', everyMs: 90 * 60_000 } }),
      NOW,
    );
    expect(every.everyMinutes).toBe(90);

    const at = cronJobToDraft(baseJob({ schedule: { kind: 'at', atMs: 1234 } }), NOW);
    expect(at.atMs).toBe(1234);

    const sysEvent = cronJobToDraft(
      baseJob({ payload: { kind: 'systemEvent', text: '事件文本' } }),
      NOW,
    );
    expect(sysEvent.payloadKind).toBe('systemEvent');
    expect(sysEvent.message).toBe('事件文本');
    expect(sysEvent.maxTurns).toBe('');
  });

  it('无任务时等价于空草稿', () => {
    expect(cronJobToDraft(undefined, NOW)).toEqual(emptyCronJobDraft(NOW));
  });
});

describe('buildCronJobCreate', () => {
  it('名称必填', () => {
    const draft = { ...emptyCronJobDraft(NOW), message: 'hi' };
    expect(buildCronJobCreate(draft)).toEqual({ ok: false, error: '请输入任务名称' });
  });

  it('提示词/事件内容必填', () => {
    const draft = { ...emptyCronJobDraft(NOW), name: '任务' };
    expect(buildCronJobCreate(draft)).toEqual({ ok: false, error: '请输入 Agent 提示词' });
    expect(buildCronJobCreate({ ...draft, payloadKind: 'systemEvent' })).toEqual({
      ok: false,
      error: '请输入事件内容',
    });
  });

  it('间隔调度转成毫秒，上下文全开时省略 context，默认模型不落库', () => {
    const result = buildCronJobCreate({
      ...emptyCronJobDraft(NOW),
      name: ' 任务 ',
      message: ' 干活 ',
      everyMinutes: 15,
      timeoutSeconds: '',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe('任务');
    expect(result.value.schedule).toEqual({ kind: 'every', everyMs: 900_000 });
    expect(result.value.payload).toEqual({ kind: 'agentTurn', message: '干活' });
    expect(result.value.notify).toBeUndefined();
  });

  it('上下文有关闭项时只下发被关闭的开关', () => {
    const result = buildCronJobCreate({
      ...emptyCronJobDraft(NOW),
      name: '任务',
      message: '干活',
      ctxPersona: false,
      ctxMemory: false,
      maxTurns: '5',
      timeoutSeconds: '0',
      model: 'g1/m1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.payload).toEqual({
      kind: 'agentTurn',
      message: '干活',
      model: 'g1/m1',
      maxTurns: 5,
      timeoutSeconds: 0,
      context: { persona: false, memory: false },
    });
  });

  it('Cron 表达式必填，时区留空时不下发 tz', () => {
    const draft = {
      ...emptyCronJobDraft(NOW),
      name: '任务',
      message: '干活',
      scheduleKind: 'cron' as const,
    };
    expect(buildCronJobCreate({ ...draft, cronExpr: '  ' })).toEqual({
      ok: false,
      error: '请输入 Cron 表达式',
    });
    const result = buildCronJobCreate({ ...draft, cronTz: '  ' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.schedule).toEqual({ kind: 'cron', expr: '0 9 * * *' });
  });

  it('一次性调度非法时间被拒绝', () => {
    const draft = {
      ...emptyCronJobDraft(NOW),
      name: '任务',
      message: '干活',
      scheduleKind: 'at' as const,
      atMs: Number.NaN,
    };
    expect(buildCronJobCreate(draft)).toEqual({ ok: false, error: '请选择有效的执行时间' });
  });

  it('钉钉通知按发送方式校验必填目标', () => {
    const draft = {
      ...emptyCronJobDraft(NOW),
      name: '任务',
      message: '干活',
      notifyEnabled: true,
      notifyChannel: 'dingtalk' as const,
    };
    expect(buildCronJobCreate(draft).ok).toBe(false);
    expect(validateCronDingtalkTarget({ ...draft, dingtalkMode: 'user' })).toContain('userId');
    expect(validateCronDingtalkTarget({ ...draft, dingtalkMode: 'chat' })).toContain('chatId');
    expect(validateCronDingtalkTarget({ ...draft, notifyChannel: 'web' })).toBeNull();

    const ok = buildCronJobCreate({ ...draft, dingtalkConversationId: ' cid1 ' });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.value.notify).toEqual({
      enabled: true,
      channel: 'dingtalk',
      onSuccess: true,
      onError: true,
      dingtalk: { mode: 'session', conversationId: 'cid1' },
    });
  });

  it('web 渠道不下发 dingtalk 段', () => {
    const result = buildCronJobCreate({
      ...emptyCronJobDraft(NOW),
      name: '任务',
      message: '干活',
      notifyEnabled: true,
      notifyChannel: 'web',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.notify).toEqual({
      enabled: true,
      channel: 'web',
      onSuccess: true,
      onError: true,
    });
  });

  it('编辑模式关掉通知时仍显式下发 enabled:false，而不是省略字段', () => {
    const result = buildCronJobCreate(
      { ...emptyCronJobDraft(NOW), name: '任务', message: '干活', notifyEnabled: false },
      { keepExistingNotify: true },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.notify?.enabled).toBe(false);
  });
});

describe('isCronDraftDirty', () => {
  it('逐字段比较，任一字段变化即为脏', () => {
    const initial = cronJobToDraft(baseJob(), NOW);
    expect(isCronDraftDirty({ ...initial }, initial)).toBe(false);
    expect(isCronDraftDirty({ ...initial, name: '改了' }, initial)).toBe(true);
    expect(isCronDraftDirty({ ...initial, ctxMemory: false }, initial)).toBe(true);
    expect(isCronDraftDirty({ ...initial, atMs: initial.atMs + 1 }, initial)).toBe(true);
  });
});
