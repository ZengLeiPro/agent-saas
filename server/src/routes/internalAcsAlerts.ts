import { createHash, timingSafeEqual } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import type { AlertNotifier, NotifiableAlertItem } from '../runtime/alertNotifier.js';
import type { AttentionSeverity } from '../runtime/attention.js';

export interface InternalAcsAlertsRouterOptions {
  alertNotifier?: AlertNotifier;
  inboundToken?: string;
}

const acsAlertSchema = z.object({
  source: z.string().min(1).max(120).optional(),
  namespace: z.string().min(1).max(120).optional(),
  event: z.string().min(1).max(160),
  severity: z.string().min(1).max(40).optional(),
  message: z.string().min(1).max(2000),
  metadata: z.record(z.string(), z.unknown()).optional(),
  occurredAt: z.string().min(1).max(120).optional(),
});

export function createInternalAcsAlertsRouter(options: InternalAcsAlertsRouterOptions): Router {
  const router = Router();

  router.post('/acs-alerts', async (req, res) => {
    // FIX-3: Express 4 不接管 async handler 异常，整体 try/catch 防 unhandled rejection。
    try {
      if (!options.inboundToken) {
        res.status(503).json({ error: 'ACS alert inbound token is not configured' });
        return;
      }
      const provided = extractBearerToken(req.headers.authorization);
      if (!provided || !safeTokenEqual(provided, options.inboundToken)) {
        res.status(401).json({ error: 'Invalid ACS alert token' });
        return;
      }
      if (!options.alertNotifier) {
        res.status(503).json({ error: 'Alert notifier is not configured' });
        return;
      }
      const parsed = acsAlertSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues.map((issue) => issue.message).join('; ') });
        return;
      }
      const body = parsed.data;
      const item: NotifiableAlertItem = {
        kind: `acs_${body.event}`,
        severity: mapSeverity(body.severity),
        title: body.message,
        occurredAt: body.occurredAt ?? new Date().toISOString(),
        actions: ['open_sandboxes'],
        // FIX-2: message 内嵌变化数值，去重键固定为 `${namespace}:${event}`。
        dedupeKey: `${body.namespace ?? 'default'}:${body.event}`,
      };
      const result = await options.alertNotifier.notifyExternal(body.source ?? 'acs-orchestrator', [item]);
      res.json({ ok: true, result });
    } catch (err) {
      res.status(500).json({ error: `ACS alert processing failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  return router;
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

// FIX-5b: 常数时间比较。先 sha256 归一长度，长度不同既不会抛异常也不泄漏时序。
function safeTokenEqual(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function mapSeverity(value: string | undefined): AttentionSeverity {
  if (value === 'critical' || value === 'high' || value === 'medium' || value === 'low' || value === 'info') return value;
  if (value === 'error') return 'high';
  if (value === 'warn' || value === 'warning') return 'medium';
  return 'high';
}
