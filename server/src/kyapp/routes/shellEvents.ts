/**
 * WP4 壳侧安全事件与审计上报（规范 §5.4）。
 *
 * 规范两处要求写审计，WP2a 都没落通道：
 * - §5.4-3「握手/证明失败 …… 记安全事件」；
 * - §5.4 `agent.open`「审计 `origin:'app_iframe', installationId`」。
 * 另有总控对 4-A-01 的拍板：壳 URL 里出现 `..`/`%2f`/`%2e`/scheme/反斜杠这类
 * 可能是攻击尝试的应用内路径时，也要落同一条审计通道。
 *
 * 这里只做「壳（已登录会话）→ 治理审计」的一条窄通道：
 * 事件种类是闭集，`detail` 一律截断，写入沿用既有 `governance_audit` 表
 * （**不需要任何 DB 迁移**）。审计不可用时回 503，客户端 fire-and-forget 忽略——
 * 壳侧安全事件是观测，不该反过来把用户界面卡住。
 */
import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';

import { governancePersonaForUser } from '../../governance/subject/platformIdentity.js';
import type { GovernanceAuditStore } from '../../data/governance-audit/types.js';
import { sendKyAppError, sendKyAppFailure } from './support.js';

/** 壳可上报的事件种类（闭集，前端同名常量在 `web/src/lib/appShellAudit.ts`）。 */
export const KY_APP_SHELL_EVENTS = [
  'handshake_failed',
  'attestation_failed',
  'path_rejected',
  'link_blocked',
  'message_rejected',
  'agent_open',
] as const;
export type KyAppShellEvent = (typeof KY_APP_SHELL_EVENTS)[number];

const bodySchema = z.object({
  event: z.enum(KY_APP_SHELL_EVENTS),
  installationId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  /** 拒绝原因（契约包的 `PathErrorCode` / `KyLinkRejectReason` 等），闭集由前端保证。 */
  reason: z.string().min(1).max(64).optional(),
  /** 附加观测值；只进审计，不回显给任何用户。 */
  detail: z.string().max(200).optional(),
});

export interface KyAppShellEventRoutesOptions {
  audit?: GovernanceAuditStore;
}

export function createKyAppShellEventsRouter(options: KyAppShellEventRoutesOptions): Router {
  const router = Router();

  router.post('/shell-events', async (req, res) => {
    if (!req.user) return sendKyAppError(req, res, 'unauthorized', '需要登录');
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) return sendKyAppError(req, res, 'invalid_input', '事件体非法');
    if (!options.audit) return sendKyAppError(req, res, 'unavailable', '治理审计暂不可用');

    const user = req.user;
    const { event, installationId, reason, detail } = parsed.data;
    try {
      await options.audit.append({
        correlationId: randomUUID(),
        actorType: 'user',
        actorUserId: user.sub,
        actorPersona: governancePersonaForUser({ role: user.role, tenantId: user.tenantId }),
        actorTenantId: user.tenantId,
        action: `ky_app.shell.${event}`,
        targetType: 'ky_app_installation',
        targetId: installationId,
        targetTenantId: user.tenantId,
        // §5.4 要求 agent.open 审计带 `origin:'app_iframe'`；其余壳事件同源，统一标注。
        purpose: 'app_iframe',
        ...(reason ? { reason } : {}),
        result: event === 'agent_open' ? 'succeeded' : 'failed',
        metadata: {
          origin: 'app_iframe',
          installationId,
          ...(detail ? { detail } : {}),
        },
      });
      res.status(204).end();
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  return router;
}
