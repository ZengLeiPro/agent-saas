import { apiLogger } from '../../utils/logger.js';

const WEBHOOK_TIMEOUT_MS = 10_000;

export async function sendDingtalkAlertWebhook(
  webhookUrl: string,
  markdown: { title: string; text: string },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown,
      }),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string };
    if (!res.ok || (body.errcode && body.errcode !== 0)) {
      apiLogger.warn(
        `[alerting] 钉钉告警推送失败 status=${res.status} errcode=${body.errcode ?? ''} errmsg=${body.errmsg ?? ''}`,
      );
    }
  } catch (err) {
    apiLogger.warn(`[alerting] 钉钉告警推送异常: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}
