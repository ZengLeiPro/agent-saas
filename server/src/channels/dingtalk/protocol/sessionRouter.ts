/**
 * DingTalk Session 管理路由
 *
 * 查看/测试钉钉会话（Webhook 路由位于同目录下 webhookRouter.ts）
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { isPlatformAdmin } from '../../../auth/types.js';

// ============================================
// Types
// ============================================

export interface DingtalkSessionSummary {
  conversationId: string;
  senderNick: string;
  senderId?: string;
  conversationType: string;
  lastUpdated: number;
  lastUpdatedAt: string;
  messageCount: number;
  hasWebhook: boolean;
  tenantId?: string;
  userId?: string;
}

interface SessionInfo {
  senderNick: string;
  senderId?: string;
  conversationType?: string;
  lastUpdated?: number;
  lastUpdatedAt?: string;
  messageCount?: number;
  sessionWebhook?: string;
  tenantId?: string;
  userId?: string;
}

interface SessionReader {
  loadSessions(): Record<string, SessionInfo>;
}

interface MessageSender {
  sendMessage(opts: {
    sessionWebhook: string;
    content: string;
    msgType: string;
  }): Promise<void>;
}

// ============================================
// Session Management Router
// ============================================

export interface DingtalkSessionRouterDeps {
  sessionService: SessionReader;
  deliveryService: MessageSender;
}

/**
 * 创建钉钉 Session 管理路由（查看会话列表、测试发送）
 */
export function createDingtalkSessionRouter(deps: DingtalkSessionRouterDeps): Router {
  const router = Router();
  const { sessionService, deliveryService } = deps;

  router.get('/sessions', async (req: Request, res: Response) => {
    try {
      const tenantId = isPlatformAdmin(req.user) ? undefined : req.user?.tenantId;
      const sessions = sessionService.loadSessions();
      const items: DingtalkSessionSummary[] = Object.entries(sessions)
        .filter(([, info]) => !tenantId || info.tenantId === tenantId)
        .map(([conversationId, info]) => ({
          conversationId,
          senderNick: info.senderNick,
          senderId: info.senderId,
          conversationType: String(info.conversationType ?? ''),
          lastUpdated: info.lastUpdated ?? 0,
          lastUpdatedAt: info.lastUpdatedAt ?? '',
          messageCount: info.messageCount ?? 0,
          hasWebhook: !!info.sessionWebhook,
          ...(info.tenantId ? { tenantId: info.tenantId } : {}),
          ...(info.userId ? { userId: info.userId } : {}),
        }))
        .sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0));

      res.json({ sessions: items });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post('/sessions/:conversationId/test', async (req: Request, res: Response) => {
    try {
      const conversationId = String(req.params.conversationId || '').trim();
      if (!conversationId) {
        res.status(400).json({ error: 'conversationId is required' });
        return;
      }

      const { message, msgType } = req.body ?? {};
      const content =
        typeof message === 'string' && message.trim()
          ? message
          : `[Cron/DingTalk 测试] ${new Date().toLocaleString('zh-CN')}`;
      const finalMsgType = msgType === 'text' ? 'text' : 'markdown';

      const sessions = sessionService.loadSessions();
      const target = sessions[conversationId];
      const tenantId = isPlatformAdmin(req.user) ? undefined : req.user?.tenantId;
      if (tenantId && target?.tenantId !== tenantId) {
        res.status(404).json({ error: 'DingTalk session not found' });
        return;
      }
      if (!target?.sessionWebhook) {
        res.status(404).json({
          error:
            'DingTalk session not found or missing sessionWebhook. 请先在对应会话里发一条消息给机器人以刷新 sessionWebhook。',
        });
        return;
      }

      await deliveryService.sendMessage({
        sessionWebhook: target.sessionWebhook,
        content,
        msgType: finalMsgType,
      });

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  return router;
}

// Backward-compatible alias.
export const createDingtalkRouter = createDingtalkSessionRouter;
