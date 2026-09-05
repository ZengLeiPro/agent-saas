import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { APNS_ENVIRONMENTS } from '../app/pushConfigSchema.js';
import type { ApnsService } from '../apns/service.js';

const registrationSchema = z.object({
  token: z.string().trim().min(32).max(400),
  deviceName: z.string().trim().min(1).max(120),
  environment: z.enum(APNS_ENVIRONMENTS).optional(),
  appVersion: z.string().trim().min(1).max(64).optional(),
});

/** iOS 系统推送设备管理：与 `/api/web-push` 同构（status / 注册 / 注销）。 */
export function createApnsRouter(service?: ApnsService): Router {
  const router = Router();

  router.get('/status', async (req: Request, res: Response) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    if (!service) {
      res.json({ configured: false, devices: [] });
      return;
    }
    try {
      res.json({ configured: true, devices: await service.list(owner) });
    } catch (error) {
      res
        .status(500)
        .json({ error: error instanceof Error ? error.message : '读取推送设备状态失败' });
    }
  });

  router.post('/devices', async (req: Request, res: Response) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    if (!service) {
      res.status(503).json({ error: 'iOS 系统推送尚未配置', code: 'APNS_NOT_CONFIGURED' });
      return;
    }
    const parsed = registrationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? '设备注册参数无效' });
      return;
    }
    try {
      res.status(201).json(await service.register(owner, parsed.data));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete('/devices/:deviceId', async (req: Request, res: Response) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    if (!service) {
      res.status(204).end();
      return;
    }
    try {
      await service.unregister(owner, req.params.deviceId);
      res.status(204).end();
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : '关闭推送失败' });
    }
  });

  return router;
}

function requireOwner(req: Request, res: Response): { tenantId: string; userId: string } | null {
  const userId = req.user?.sub;
  const tenantId = req.user?.tenantId;
  if (!userId || !tenantId) {
    res.status(401).json({ error: '需要登录后管理推送设备' });
    return null;
  }
  return { tenantId, userId };
}
