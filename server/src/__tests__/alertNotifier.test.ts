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

  async markNotified(alertKey: string, notifiedAt = new Date()) {
    const state = this.states.get(alertKey);
    if (!state) return;
    state.lastNotifiedAt = notifiedAt.toISOString();
    state.notifyCount += 1;
  }

  async cleanupGone(activeKeys: string[], olderThanMs: number, now = new Date()) {
    const cutoff = now.getTime() - olderThanMs;
    let removed = 0;
    for (const [key, state] of [...this.states]) {
      if (activeKeys.includes(key)) continue;
      if (Date.parse(state.lastSeenAt) < cutoff) {
        this.states.delete(key);
        removed += 1;
      }
    }
    return removed;
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

    expect(await notifier.notifyExternal('attention', [
      { kind: 'disk_root_high', severity: 'high', title: '根盘用量 85.3%' },
    ])).toMatchObject({ considered: 1, notified: 1 });
    expect(await notifier.notifyExternal('attention', [
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
    expect(errors.some((msg) => msg.includes('webhook send failed'))).toBe(true);
    expect(store.states.get('failed_run:global')?.lastNotifiedAt).toBeNull();

    // last_notified_at 未写 → 下一轮继续尝试发送
    await notifier.notifyExternal('test', [item]);
    expect(sender).toHaveBeenCalledTimes(2);
  });

  it('cleans up keys that disappeared for more than 24h', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-07T00:00:00.000Z'));
    const store = new FakeAlertStateStore();
    const notifier = createNotifier([], store);

    await notifier.notifyExternal('test', [{ kind: 'failed_run', severity: 'high', title: 'Run failed', entityRef: { kind: 'run', id: 'r1' } }]);
    expect(store.states.has('failed_run:r1')).toBe(true);

    vi.setSystemTime(new Date('2026-07-08T01:00:00.000Z'));
    await notifier.notifyExternal('test', [{ kind: 'stale_run', severity: 'high', title: 'Stale run', entityRef: { kind: 'run', id: 'r2' } }]);
    expect(store.states.has('failed_run:r1')).toBe(false);
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
