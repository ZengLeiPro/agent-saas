import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { WebPushService } from '../webPush/service.js';

const subscriptionSchema = z.object({
  endpoint: z.string().min(1).max(4096),
  keys: z.object({
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(512),
  }),
  deviceName: z.string().trim().min(1).max(120),
});

export function createWebPushRouter(service?: WebPushService): Router {
  const router = Router();

  router.get('/status', async (req: Request, res: Response) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    if (!service) {
      res.json({ configured: false, publicKey: null, subscriptions: [] });
      return;
    }
    try {
      res.json({
        configured: true,
        publicKey: service.publicKey,
        subscriptions: await service.list(owner),
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : '读取浏览器通知状态失败' });
    }
  });

  router.post('/subscriptions', async (req: Request, res: Response) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    if (!service) {
      res.status(503).json({ error: '浏览器桌面通知尚未配置', code: 'WEB_PUSH_NOT_CONFIGURED' });
      return;
    }
    const parsed = subscriptionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '订阅参数无效' });
      return;
    }
    try {
      res.status(201).json(await service.subscribe(owner, parsed.data));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete('/subscriptions/:subscriptionId', async (req: Request, res: Response) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    if (!service) {
      res.status(204).end();
      return;
    }
    try {
      await service.unsubscribe(owner, req.params.subscriptionId);
      res.status(204).end();
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : '关闭浏览器通知失败' });
    }
  });

  return router;
}

function requireOwner(req: Request, res: Response): { tenantId: string; userId: string } | null {
  const userId = req.user?.sub;
  const tenantId = req.user?.tenantId;
  if (!userId || !tenantId) {
    res.status(401).json({ error: '需要登录后管理浏览器通知' });
    return null;
  }
  return { tenantId, userId };
}
