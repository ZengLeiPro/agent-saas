import type { AppConfig } from '../app/config.js';
import type { BillingService } from '../data/billing/service.js';
import type { SecretVault } from '../security/secretVault.js';
import { sendDingtalkAlertWebhook } from '../integrations/dingtalk/alertWebhook.js';
import type { PgAlertStateStore } from './alertStateStore.js';
import {
  type AttentionItem,
  type AttentionSeverity,
  buildAttentionQueue,
  fetchSandboxSummaries,
} from './attention.js';
import type { PgEventStore } from './pgEventStore.js';
import type { PgRunStore } from './runStore.js';
import type { PgSystemMetricsStore } from './systemMetricsStore.js';

const SEVERITY_RANK: Record<AttentionSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const DEFAULT_REPEAT_INTERVAL_MS: Record<AttentionSeverity, number> = {
  critical: 4 * 60 * 60_000,
  high: 12 * 60 * 60_000,
  medium: 24 * 60 * 60_000,
  low: 24 * 60 * 60_000,
  info: 24 * 60 * 60_000,
};

/**
 * FIX-2: 外部接入（notifyExternal）可按条携带 dedupeKey，覆盖默认的
 * `${kind}:${entityRef.id|global}` 去重键：ACS inbound 传 `${namespace}:${event}`，
 * billing audit 传 message hash（每条 alert 语义不同）。
 */
export type NotifiableAlertItem = AttentionItem & { dedupeKey?: string };

export interface AlertNotifierOptions {
  config: AppConfig;
  alertStateStore: PgAlertStateStore;
  runStore?: PgRunStore;
  eventStore?: PgEventStore;
  systemMetricsStore?: PgSystemMetricsStore;
  billingService?: BillingService;
  secretVault?: SecretVault;
  fetchImpl?: typeof fetch;
  acsTimeoutMs?: number;
  webBaseUrl?: string;
  sender?: (webhookUrl: string, markdown: { title: string; text: string }) => Promise<void>;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}

export class AlertNotifier {
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight = false;
  private readonly sender: (webhookUrl: string, markdown: { title: string; text: string }) => Promise<void>;

  constructor(private readonly options: AlertNotifierOptions) {
    this.sender = options.sender ?? ((webhookUrl, markdown) => sendDingtalkAlertWebhook(webhookUrl, markdown, options.fetchImpl ?? fetch));
  }

  start(): void {
    const cfg = this.options.config.alerting;
    if (cfg?.enabled === false || !cfg?.dingtalkWebhook) return;
    if (this.timer) return;
    const intervalMs = cfg.evaluateIntervalMs ?? 120_000;
    // FIX-3: evaluateOnce 异常必须被 catch，否则 PG 抖动即 unhandled rejection（index.ts 会 process.exit(1)）。
    this.timer = setInterval(() => {
      void this.evaluateOnce().catch((err) => {
        this.options.logger?.warn(`AlertNotifier evaluate failed: ${errorMessage(err)}`);
      });
    }, intervalMs);
    this.timer.unref?.();
    this.options.logger?.info(`AlertNotifier started: evaluateIntervalMs=${intervalMs} minSeverity=${cfg.minSeverity ?? 'high'}`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async evaluateOnce(): Promise<{ considered: number; notified: number }> {
    if (this.inFlight) return { considered: 0, notified: 0 };
    const cfg = this.options.config.alerting;
    if (cfg?.enabled === false || !cfg?.dingtalkWebhook) return { considered: 0, notified: 0 };
    this.inFlight = true;
    try {
      const sandboxes = await fetchSandboxSummaries({
        config: this.options.config,
        secretVault: this.options.secretVault,
        fetchImpl: this.options.fetchImpl,
        acsTimeoutMs: this.options.acsTimeoutMs,
      }).catch((err) => {
        this.options.logger?.warn(`AlertNotifier sandbox fetch failed: ${errorMessage(err)}`);
        return [];
      });
      const items = await buildAttentionQueue({
        runStore: this.options.runStore,
        eventStore: this.options.eventStore,
        systemMetricsStore: this.options.systemMetricsStore,
        billingService: this.options.billingService,
        dailyCostThresholdYuan: cfg.dailyCostThresholdYuan,
        sandboxes,
      });
      return await this.notifyItems('attention', items);
    } finally {
      this.inFlight = false;
    }
  }

  async notifyExternal(source: string, items: NotifiableAlertItem[]): Promise<{ considered: number; notified: number }> {
    return await this.notifyItems(source, items);
  }

  async sendTestAlert(): Promise<void> {
    const cfg = this.options.config.alerting;
    if (cfg?.enabled === false || !cfg?.dingtalkWebhook) {
      throw new Error('Alerting webhook is not configured');
    }
    const item: AttentionItem = {
      kind: 'test_alert',
      severity: 'high',
      title: '测试告警',
      occurredAt: new Date().toISOString(),
      actions: ['verify_dingtalk'],
    };
    await this.sender(cfg.dingtalkWebhook, this.renderMarkdown([item], 'test'));
  }

  async getStatus(): Promise<{
    configured: boolean;
    webhookConfigured: boolean;
    webhookMasked: string | null;
    minSeverity: AttentionSeverity;
    lastNotifiedAt: string | null;
    notifyCount: number;
  }> {
    const cfg = this.options.config.alerting;
    const summary = await this.options.alertStateStore.summary();
    const webhook = cfg?.dingtalkWebhook;
    return {
      configured: cfg?.enabled !== false && !!webhook,
      webhookConfigured: !!webhook,
      webhookMasked: webhook ? maskWebhook(webhook) : null,
      minSeverity: parseSeverity(cfg?.minSeverity) ?? 'high',
      lastNotifiedAt: summary.lastNotifiedAt,
      notifyCount: summary.notifyCount,
    };
  }

  private async notifyItems(source: string, items: NotifiableAlertItem[]): Promise<{ considered: number; notified: number }> {
    const cfg = this.options.config.alerting;
    if (cfg?.enabled === false || !cfg?.dingtalkWebhook) return { considered: items.length, notified: 0 };
    const minSeverity = parseSeverity(cfg.minSeverity) ?? 'high';
    const now = new Date();
    const eligible = items.filter((item) => severityRank(item.severity) >= severityRank(minSeverity));
    const toNotify: AttentionItem[] = [];
    const activeKeys: string[] = [];
    for (const item of eligible) {
      const key = alertKey(source, item);
      activeKeys.push(key);
      const state = await this.options.alertStateStore.touch(key, item.severity, now);
      if (!state.lastNotifiedAt) {
        toNotify.push(item);
        continue;
      }
      const repeatMs = this.repeatIntervalMs(item.severity);
      if (now.getTime() - Date.parse(state.lastNotifiedAt) >= repeatMs) {
        toNotify.push(item);
      }
    }
    await this.options.alertStateStore.cleanupGone(activeKeys, 24 * 60 * 60_000, now).catch((err) => {
      this.options.logger?.warn(`AlertNotifier cleanup failed: ${errorMessage(err)}`);
      return 0;
    });
    if (toNotify.length === 0) return { considered: eligible.length, notified: 0 };
    try {
      await this.sender(cfg.dingtalkWebhook, this.renderMarkdown(toNotify, source));
    } catch (err) {
      // 文档 §6.4：webhook 发送失败打日志不重试不抛出；不写 last_notified_at，下轮自然重试。
      this.options.logger?.error(`AlertNotifier webhook send failed: ${errorMessage(err)}`);
      return { considered: eligible.length, notified: 0 };
    }
    await Promise.all(toNotify.map((item) => this.options.alertStateStore.markNotified(alertKey(source, item), now)));
    return { considered: eligible.length, notified: toNotify.length };
  }

  private repeatIntervalMs(severity: AttentionSeverity): number {
    const configured = this.options.config.alerting?.repeatIntervalMs?.[severity];
    return configured ?? DEFAULT_REPEAT_INTERVAL_MS[severity];
  }

  private renderMarkdown(items: AttentionItem[], source: string): { title: string; text: string } {
    const title = 'agent-saas 告警';
    const lines = [
      `### ${title}`,
      `- 来源：${source}`,
      `- 时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      '',
      ...items.flatMap((item) => [
        `#### [${item.severity.toUpperCase()}] ${item.title}`,
        item.occurredAt ? `- 发生时间：${item.occurredAt}` : null,
        item.entityRef ? `- 关联对象：[${item.entityRef.kind}:${item.entityRef.id}](${this.entityUrl(item)})` : null,
        item.actions?.length ? `- 建议动作：${item.actions.join(' / ')}` : null,
        '',
      ].filter((line): line is string => !!line)),
    ];
    return { title, text: lines.join('\n') };
  }

  private entityUrl(item: AttentionItem): string {
    const base = this.options.webBaseUrl ?? 'https://agent.kaiyan.net';
    const ref = item.entityRef;
    if (!ref) return `${base}/platform-admin/overview`;
    const section = ref.kind === 'run'
      ? 'runs'
      : ref.kind === 'session'
        ? 'sessions'
        : ref.kind === 'sandbox'
          ? 'sandboxes'
          : ref.kind === 'user'
            ? 'users'
            : 'tenants';
    return `${base}/platform-admin/${section}/${encodeURIComponent(ref.id)}`;
  }
}

/**
 * FIX-2: 回到文档 §6.3 设计 —— key 不含 title。title 内嵌持续变化的数值
 * （如 "85.3%"、金额、剩余天数），拿 title 兜底会让每次数值变化都生成新 key，
 * 完全绕过 repeatInterval 抑制。无 entityRef 一律 `${kind}:global`。
 * 外部接入项可传 dedupeKey，最终 key 为 `${source}:${dedupeKey}`。
 */
export function alertKey(source: string, item: NotifiableAlertItem): string {
  if (item.dedupeKey) return `${source}:${item.dedupeKey}`;
  return `${item.kind}:${item.entityRef?.id ?? 'global'}`;
}

function parseSeverity(value: string | undefined): AttentionSeverity | null {
  if (value === 'critical' || value === 'high' || value === 'medium' || value === 'low' || value === 'info') return value;
  return null;
}

function severityRank(value: AttentionSeverity): number {
  return SEVERITY_RANK[value] ?? 0;
}

// FIX-5a: 只回显「已配置 + webhook 域名」，不回显 access_token 的任何字符。
function maskWebhook(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'configured';
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
