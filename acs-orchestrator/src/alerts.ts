import type { AcsOrchestratorConfig } from './config.js';

export interface AcsLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface AcsAlert {
  event: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  metadata?: unknown;
}

export class AlertDispatcher {
  private readonly lastAlertAtByEvent = new Map<string, number>();

  constructor(
    private readonly config: AcsOrchestratorConfig,
    private readonly logger: AcsLogger,
  ) {}

  async emit(input: AcsAlert): Promise<void> {
    const log =
      input.severity === 'error'
        ? this.logger.error
        : input.severity === 'warning'
          ? this.logger.warn
          : this.logger.info;
    log(`alert event=${input.event} severity=${input.severity} message=${input.message}`);
    if (this.config.alertWebhookUrls.length === 0) return;
    const now = Date.now();
    const lastAt = this.lastAlertAtByEvent.get(input.event) ?? 0;
    if (this.config.alertMinIntervalMs > 0 && now - lastAt < this.config.alertMinIntervalMs) return;
    this.lastAlertAtByEvent.set(input.event, now);
    const body = JSON.stringify({
      source: 'agent-saas-acs-orchestrator',
      namespace: this.config.namespace,
      event: input.event,
      severity: input.severity,
      message: input.message,
      metadata: input.metadata ?? {},
      occurredAt: new Date().toISOString(),
    });
    const errors: string[] = [];
    for (const url of this.config.alertWebhookUrls) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      timer.unref?.();
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.config.alertWebhookBearerToken
              ? { authorization: `Bearer ${this.config.alertWebhookBearerToken}` }
              : {}),
          },
          body,
          signal: controller.signal,
        });
        if (response.ok) return;
        errors.push(`HTTP ${response.status} (${url})`);
      } catch (error) {
        errors.push(`${error instanceof Error ? error.message : String(error)} (${url})`);
      } finally {
        clearTimeout(timer);
      }
    }
    this.logger.warn(
      `alert webhook failed on all ${this.config.alertWebhookUrls.length} url(s): ${errors.join('; ')}`,
    );
  }
}
