import { afterEach, describe, expect, it, vi } from 'vitest';

import { AlertNotifier, alertKey } from '../runtime/alertNotifier.js';
import type { PgAlertStateStore } from '../runtime/alertStateStore.js';
import type { AttentionItem } from '../runtime/attention.js';

class FakeAlertStateStore {
  states = new Map<string, {
    alertKey: string;
    severity: string;
    firstSeenAt: string;
    lastSeenAt: string;
    lastNotifiedAt: string | null;
    notifyCount: number;
  }>();
  claims = new Map<string, string>();
  evaluationClaimToken: string | null = null;
  nextClaimId = 0;

  async get(alertKey: string) {
    return this.states.get(alertKey) ?? null;
  }

  async touch(alertKey: string, severity: string, seenAt = new Date()) {
    const existing = this.states.get(alertKey);
    if (existing) {
      existing.severity = severity;
      existing.lastSeenAt = seenAt.toISOString();
      return existing;
    }
    const record = {
      alertKey,
      severity,
      firstSeenAt: seenAt.toISOString(),
      lastSeenAt: seenAt.toISOString(),
      lastNotifiedAt: null,
      notifyCount: 0,
    };
    this.states.set(alertKey, record);
    return record;
  }

  async tryClaimNotification(alertKey: string, expectedLastNotifiedAt: string | null) {
    const state = this.states.get(alertKey);
    if (!state || state.lastNotifiedAt !== expectedLastNotifiedAt || this.claims.has(alertKey)) return null;
    const token = `claim-${++this.nextClaimId}`;
    this.claims.set(alertKey, token);
    return token;
  }

  async releaseNotificationClaim(alertKey: string, claimToken: string) {
    if (this.claims.get(alertKey) === claimToken) this.claims.delete(alertKey);
  }

  async tryClaimEvaluation() {
    if (this.evaluationClaimToken) return null;
    this.evaluationClaimToken = `evaluation-${++this.nextClaimId}`;
    return this.evaluationClaimToken;
  }

  async isEvaluationClaimOwner(claimToken: string) {
    return this.evaluationClaimToken === claimToken;
  }

  async releaseEvaluationClaim(claimToken: string) {
    if (this.evaluationClaimToken === claimToken) this.evaluationClaimToken = null;
  }

  async markNotified(alertKey: string, claimToken: string, notifiedAt = new Date()) {
    const state = this.states.get(alertKey);
    if (!state || this.claims.get(alertKey) !== claimToken) return;
    state.lastNotifiedAt = notifiedAt.toISOString();
    state.notifyCount += 1;
    this.claims.delete(alertKey);
  }

  async remove(alertKey: string) {
    this.states.delete(alertKey);
    this.claims.delete(alertKey);
  }

  async removeClaimed(alertKey: string, claimToken: string, expectedLastSeenAt: string) {
    const state = this.states.get(alertKey);
    if (!state || state.lastSeenAt !== expectedLastSeenAt || this.claims.get(alertKey) !== claimToken) return;
    this.states.delete(alertKey);
    this.claims.delete(alertKey);
  }

  async summary() {
    const states = [...this.states.values()];
    return {
      configured: true,
      lastNotifiedAt: states.map(s => s.lastNotifiedAt).filter(Boolean).sort().at(-1) ?? null,
      notifyCount: states.reduce((sum, state) => sum + state.notifyCount, 0),
    };
  }
}

describe('alertKey', () => {
  it('uses kind:global for items without entityRef (title changes do not change the key)', () => {
    const a: AttentionItem = { kind: 'disk_root_high', severity: 'high', title: '根盘用量 85.3%' };
    const b: AttentionItem = { kind: 'disk_root_high', severity: 'high', title: '根盘用量 85.4%' };
    expect(alertKey('attention', a)).toBe('disk_root_high:global');
    expect(alertKey('attention', a)).toBe(alertKey('attention', b));
  });

  it('uses kind:entityRef.id when entityRef exists', () => {
    const item: AttentionItem = {
      kind: 'failed_run',
      severity: 'high',
      title: 'Run r1 failed with exit 1',
      entityRef: { kind: 'run', id: 'r1' },
    };
    expect(alertKey('attention', item)).toBe('failed_run:r1');
  });

  it('prefers explicit dedupeKey for external sources', () => {
    expect(alertKey('acs-orchestrator', {
      kind: 'acs_sandbox_down',
      severity: 'high',
      title: 'sandbox ns1/sb1 down for 312s',
      dedupeKey: 'ns1:sandbox_down',
    })).toBe('acs-orchestrator:ns1:sandbox_down');
  });
});

describe('AlertNotifier', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createNotifier(
    sent: string[],
    store = new FakeAlertStateStore(),
    overrides: {
      sender?: (webhookUrl: string, markdown: { title: string; text: string }) => Promise<void>;
      logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
      runStore?: any;
    } = {},
  ) {
    return new AlertNotifier({
      config: {
        alerting: {
          enabled: true,
          dingtalkWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=token',
          minSeverity: 'high',
          repeatIntervalMs: { high: 60_000 },
        },
      } as any,
      alertStateStore: store as unknown as PgAlertStateStore,
      runStore: overrides.runStore,
      externalIncidentSelector: (_source, items) => items,
      sender: overrides.sender ?? (async (_webhook, markdown) => {
        sent.push(markdown.text);
      }),
      logger: overrides.logger,
    });
  }

  it('pushes a new eligible alert once and suppresses repeats inside interval', async () => {
    const sent: string[] = [];
    const notifier = createNotifier(sent);
    const item: AttentionItem = { kind: 'failed_run', severity: 'high', title: 'Run failed' };

    expect(await notifier.notifyExternal('test', [item])).toMatchObject({ considered: 1, notified: 1 });
    expect(await notifier.notifyExternal('test', [item])).toMatchObject({ considered: 1, notified: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('[HIGH] Run failed');
  });

  it('FIX-2 regression: same kind with changing numeric title stays suppressed inside repeatInterval', async () => {
    const sent: string[] = [];
    const notifier = createNotifier(sent);

    expect(await notifier.notifyExternal('test', [
      { kind: 'disk_root_high', severity: 'high', title: '根盘用量 85.3%' },
    ])).toMatchObject({ considered: 1, notified: 1 });
    expect(await notifier.notifyExternal('test', [
      { kind: 'disk_root_high', severity: 'high', title: '根盘用量 85.4%' },
    ])).toMatchObject({ considered: 1, notified: 0 });
    expect(sent).toHaveLength(1);
  });

  it('filters below min severity', async () => {
    const sent: string[] = [];
    const notifier = createNotifier(sent);

    expect(await notifier.notifyExternal('test', [
      { kind: 'stale_run', severity: 'medium', title: 'Stale run' },
    ])).toMatchObject({ considered: 0, notified: 0 });
    expect(sent).toHaveLength(0);
  });

  it('merges a batch into a single markdown message', async () => {
    const sent: string[] = [];
    const notifier = createNotifier(sent);

    expect(await notifier.notifyExternal('test', [
      { kind: 'failed_run', severity: 'high', title: 'Run failed', entityRef: { kind: 'run', id: 'r1' } },
      { kind: 'tls_cert_expiring', severity: 'critical', title: 'TLS cert expiring in 3 days' },
    ])).toMatchObject({ considered: 2, notified: 2 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('[HIGH] Run failed');
    expect(sent[0]).toContain('[CRITICAL] TLS cert expiring in 3 days');
  });

  it('claims notification state so concurrent notifier instances only deliver once', async () => {
    const store = new FakeAlertStateStore();
    const sent: string[] = [];
    const sender = async (_webhook: string, markdown: { title: string; text: string }) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      sent.push(markdown.text);
    };
    const first = createNotifier(sent, store, { sender });
    const second = createNotifier(sent, store, { sender });
    const item: AttentionItem = { kind: 'platform_run_failure_spike', severity: 'high', title: 'Failure spike' };

    const results = await Promise.all([
      first.notifyExternal('test', [item]),
      second.notifyExternal('test', [item]),
    ]);

    expect(results.reduce((sum, result) => sum + result.notified, 0)).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('does not throw when the webhook sender fails and retries on next round', async () => {
    const store = new FakeAlertStateStore();
    const errors: string[] = [];
    const sender = vi.fn(async () => { throw new Error('dingtalk 500'); });
    const notifier = createNotifier([], store, {
      sender,
      logger: { info: () => {}, warn: () => {}, error: (msg) => errors.push(msg) },
    });
    const item: AttentionItem = { kind: 'failed_run', severity: 'high', title: 'Run failed' };

    await expect(notifier.notifyExternal('test', [item])).resolves.toMatchObject({ considered: 1, notified: 0 });
    expect(errors.some((msg) => msg.includes('delivery failed') && msg.includes('dingtalk 500'))).toBe(true);
    expect(store.states.get('failed_run:global')?.lastNotifiedAt).toBeNull();

    // last_notified_at 未写 → 下一轮继续尝试发送
    await notifier.notifyExternal('test', [item]);
    expect(sender).toHaveBeenCalledTimes(2);
  });

  it('delivers via dingtalk robot oTo channel when only dingtalkRobot is configured', async () => {
    const robotSent: Array<{ config: { receiverUserIds: string[] }; text: string }> = [];
    const notifier = new AlertNotifier({
      config: {
        alerting: {
          enabled: true,
          dingtalkRobot: {
            appKey: 'ding-test-key',
            appSecret: 'secret',
            receiverUserIds: ['0817456921848268'],
          },
          minSeverity: 'medium',
        },
      } as any,
      alertStateStore: new FakeAlertStateStore() as unknown as PgAlertStateStore,
      sender: async () => { throw new Error('webhook should not be called'); },
      robotSender: async (config, markdown) => { robotSent.push({ config, text: markdown.text }); },
    });

    expect(await notifier.notifyExternal('agent-saas-acs-orchestrator', [
      { kind: 'acs_sandbox_lifecycle_failed', severity: 'high', title: 'ACS Sandbox lifecycle failed' },
    ])).toMatchObject({ considered: 1, notified: 1 });
    expect(robotSent).toHaveLength(1);
    expect(robotSent[0]!.config.receiverUserIds).toEqual(['0817456921848268']);
    expect(robotSent[0]!.text).toContain('lifecycle failed');
    const status = await notifier.getStatus();
    expect(status).toMatchObject({ configured: true, webhookConfigured: false, robotConfigured: true, robotReceiverCount: 1 });
  });

  it('treats partial channel failure as delivered (webhook fails, robot succeeds)', async () => {
    const warns: string[] = [];
    const robotSent: string[] = [];
    const store = new FakeAlertStateStore();
    const notifier = new AlertNotifier({
      config: {
        alerting: {
          enabled: true,
          dingtalkWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=token',
          dingtalkRobot: { appKey: 'k', appSecret: 's', receiverUserIds: ['u1'] },
          minSeverity: 'high',
        },
      } as any,
      alertStateStore: store as unknown as PgAlertStateStore,
      sender: async () => { throw new Error('dingtalk 500'); },
      robotSender: async (_config, markdown) => { robotSent.push(markdown.text); },
      logger: { info: () => {}, warn: (msg) => warns.push(msg), error: () => {} },
    });

    expect(await notifier.notifyExternal('agent-saas-acs-orchestrator', [
      { kind: 'acs_sandbox_lifecycle_failed', severity: 'high', title: 'ACS lifecycle failed' },
    ])).toMatchObject({ considered: 1, notified: 1 });
    expect(robotSent).toHaveLength(1);
    expect(warns.some((msg) => msg.includes('partial delivery failure'))).toBe(true);
    // 任一通道成功即 markNotified，避免下一轮重复轰炸
    expect(store.states.get('acs_sandbox_lifecycle_failed:global')?.lastNotifiedAt).not.toBeNull();
  });

  it('keeps routine billing and medium ACS events on the analysis page instead of DingTalk', async () => {
    const sent: string[] = [];
    const notifier = new AlertNotifier({
      config: {
        alerting: {
          enabled: true,
          dingtalkWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=token',
          minSeverity: 'medium',
        },
      } as any,
      alertStateStore: new FakeAlertStateStore() as unknown as PgAlertStateStore,
      sender: async (_webhook, markdown) => { sent.push(markdown.text); },
    });

    expect(await notifier.notifyExternal('billing_audit', [
      { kind: 'billing_audit', severity: 'high', title: 'margin below 45%' },
    ])).toMatchObject({ considered: 1, notified: 0 });
    expect(await notifier.notifyExternal('agent-saas-acs-orchestrator', [
      { kind: 'acs_sandbox_stale_image_prewarm', severity: 'medium', title: 'prewarm failed' },
    ])).toMatchObject({ considered: 1, notified: 0 });
    expect(sent).toHaveLength(0);
  });

  it('skips platform evaluation while another instance owns the evaluation lease', async () => {
    const store = new FakeAlertStateStore();
    store.evaluationClaimToken = 'owned-by-another-instance';
    const query = vi.fn(async () => ({ rows: [] }));
    const notifier = createNotifier([], store, {
      runStore: { pool: { query }, runsTable: 'runtime_runs' },
    });

    expect(await notifier.evaluateOnce()).toEqual({ considered: 0, notified: 0 });
    expect(query).not.toHaveBeenCalled();
  });

  it('does not send recovery after losing the evaluation lease', async () => {
    const sent: string[] = [];
    const store = new FakeAlertStateStore();
    store.states.set('platform_run_failure_spike:global', {
      alertKey: 'platform_run_failure_spike:global',
      severity: 'high',
      firstSeenAt: '2026-08-01T00:00:00.000Z',
      lastSeenAt: '2026-08-01T00:00:00.000Z',
      lastNotifiedAt: '2026-08-01T00:01:00.000Z',
      notifyCount: 1,
    });
    let ownershipChecks = 0;
    store.isEvaluationClaimOwner = async () => ++ownershipChecks === 1;
    const notifier = createNotifier(sent, store, {
      runStore: {
        pool: { query: async (sql: string) => ({ rows: sql.includes('WITH recent_terminal')
          ? [{ recent_total: '10', recent_failed: '0', failed_users: '0', stalled_pending: '0', stalled_users: '0' }]
          : [] }) },
        runsTable: 'runtime_runs',
      },
    });

    await notifier.evaluateOnce();
    expect(sent).toHaveLength(0);
    expect(store.states.has('platform_run_failure_spike:global')).toBe(true);
    expect(store.claims.has('platform_run_failure_spike:global')).toBe(false);
  });

  it('sends one recovery notification after a platform incident clears, even after 24h', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
    const sent: string[] = [];
    const store = new FakeAlertStateStore();
    let incidentActive = true;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('WITH recent_terminal')) {
        return {
          rows: [incidentActive
            ? { recent_total: '10', recent_failed: '7', failed_users: '3', stalled_pending: '0', stalled_users: '0' }
            : { recent_total: '10', recent_failed: '0', failed_users: '0', stalled_pending: '0', stalled_users: '0' }],
        };
      }
      return { rows: [] };
    });
    const notifier = createNotifier(sent, store, {
      runStore: { pool: { query }, runsTable: 'runtime_runs' },
    });

    expect(await notifier.evaluateOnce()).toMatchObject({ notified: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('平台近 10 分钟 Run 失败率');

    incidentActive = false;
    vi.setSystemTime(new Date('2026-08-02T01:00:00.000Z'));
    expect(await notifier.evaluateOnce()).toMatchObject({ notified: 0 });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('恢复通知');
    expect(sent[1]).toContain('失败率已恢复');
    expect(store.states.has('platform_run_failure_spike:global')).toBe(false);

    await notifier.evaluateOnce();
    expect(sent).toHaveLength(2);
  });

  it('does not delete unrelated alert state when another source is evaluated later', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-07T00:00:00.000Z'));
    const store = new FakeAlertStateStore();
    const notifier = createNotifier([], store);

    await notifier.notifyExternal('test', [{ kind: 'failed_run', severity: 'high', title: 'Run failed', entityRef: { kind: 'run', id: 'r1' } }]);
    expect(store.states.has('failed_run:r1')).toBe(true);

    vi.setSystemTime(new Date('2026-07-08T01:00:00.000Z'));
    await notifier.notifyExternal('test', [{ kind: 'stale_run', severity: 'high', title: 'Stale run', entityRef: { kind: 'run', id: 'r2' } }]);
    expect(store.states.has('failed_run:r1')).toBe(true);
    expect(store.states.has('stale_run:r2')).toBe(true);
  });

  it('FIX-3 regression: interval callback catches evaluateOnce failures (no unhandled rejection)', async () => {
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const warns: string[] = [];
      const notifier = createNotifier([], new FakeAlertStateStore(), {
        logger: { info: () => {}, warn: (msg) => warns.push(msg), error: () => {} },
      });
      vi.spyOn(notifier, 'evaluateOnce').mockRejectedValue(new Error('pg down'));

      notifier.start();
      await vi.advanceTimersByTimeAsync(120_000);
      notifier.stop();

      expect(warns.some((msg) => msg.includes('evaluate failed') && msg.includes('pg down'))).toBe(true);
      vi.useRealTimers();
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('masks the webhook down to its hostname only', async () => {
    const store = new FakeAlertStateStore();
    const notifier = createNotifier([], store);
    const status = await notifier.getStatus();
    expect(status.webhookConfigured).toBe(true);
    expect(status.webhookMasked).toBe('oapi.dingtalk.com');
    expect(status.webhookMasked).not.toContain('token');
    expect(status.webhookMasked).not.toContain('access_token');
  });
});
