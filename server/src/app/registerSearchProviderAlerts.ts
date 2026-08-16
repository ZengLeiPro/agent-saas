import { createHash } from 'crypto';

import { setSearchProviderAlertHandler } from '../agent/web/searchRouter.js';
import type { AlertNotifier } from '../runtime/alertNotifier.js';

interface AlertLogger {
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

/**
 * 把 WebSearch provider 的连续失败接进既有告警链。
 *
 * 背景：2026-07-28 腾讯 WSA 欠费后全租户 WebSearch 静默失败 19 天无人察觉——
 * tool_audit 里全是 error，但没有任何主动信号，只有人工查库才看得见。搜索是
 * 面向客户的能力，断了必须自己喊，而不是等用户报障。
 */
export function registerSearchProviderAlerts(alertNotifier: AlertNotifier, logger: AlertLogger): void {
  setSearchProviderAlertHandler(({ provider, consecutiveFailures, lastError }) => {
    const title = `WebSearch provider ${provider} 连续 ${consecutiveFailures} 次失败：${lastError}`;
    logger.error(title);
    void alertNotifier.notifyExternal('web_search_provider', [{
      kind: 'web_search_provider_failure',
      severity: 'high' as const,
      title,
      occurredAt: new Date().toISOString(),
      // provider 维度去重，避免一次故障刷屏；成功后计数清零，下次故障可再次告警。
      dedupeKey: `web_search_provider:${provider}`,
    }]).catch((err) => {
      logger.warn(`WebSearch provider 告警发送失败: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
}

/** 与上面同属「把外部信号接进 AlertNotifier」，一并收在本文件，避免 runtime.ts 继续堆积。 */
export async function notifyBillingAuditAlerts(
  alertNotifier: AlertNotifier | undefined,
  alerts: string[],
): Promise<void> {
  if (alerts.length === 0) return;
  await alertNotifier?.notifyExternal('billing_audit', alerts.map((message) => ({
    kind: 'billing_audit',
    severity: 'high' as const,
    title: message,
    occurredAt: new Date().toISOString(),
    actions: ['open_billing'],
    // FIX-2: billing audit 每条 alert 语义不同，去重键保留 message hash（文档 §6.5）。
    dedupeKey: createHash('sha1').update(message).digest('hex').slice(0, 16),
  })));
}
