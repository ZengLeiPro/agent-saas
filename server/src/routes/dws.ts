import { Router } from 'express';

import type { DwsConnectionRecord, DwsConnectionStore } from '../dws/store.js';

export interface DwsRouterOptions {
  connectionStore?: DwsConnectionStore;
}

export function createDwsRouter(options: DwsRouterOptions): Router {
  const router = Router();

  router.get('/dws/connections', async (req, res) => {
    if (!req.user?.sub || !req.user.tenantId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!options.connectionStore) {
      res.status(503).json({ error: '钉钉连接状态服务暂不可用' });
      return;
    }
    try {
      const rows = await options.connectionStore.listForUser(req.user.tenantId, req.user.sub);
      res.json({ connections: rows.map(toPublicConnection) });
    } catch {
      res.status(503).json({ error: '钉钉连接状态读取失败' });
    }
  });

  return router;
}

function toPublicConnection(row: DwsConnectionRecord): Record<string, unknown> {
  return {
    profileId: row.profileId,
    profileName: row.profileName ?? null,
    corpName: row.corpName ?? null,
    dingtalkUserName: row.dingtalkUserName ?? null,
    status: row.connectionStatus,
    authenticated: row.authenticated ?? null,
    refreshTokenValid: row.refreshTokenValid ?? null,
    refreshExpiresAt: row.refreshExpiresAt ?? null,
    lastCheckedAt: row.lastCheckedAt ?? null,
    nextCheckAt: row.nextCheckAt,
    message: publicStatusMessage(row),
  };
}

function publicStatusMessage(row: DwsConnectionRecord): string {
  if (row.connectionStatus === 'connected') return '登录状态由平台自动维护，无需定期重新授权';
  if (row.connectionStatus === 'pending') return '已发现钉钉授权，平台正在完成首次检测';
  if (row.connectionStatus === 'error') return '自动检测暂时失败，平台会继续重试';
  return '钉钉授权已失效，请在对话中重新连接';
}
