import { Router } from 'express';

import type { UserStore } from '../data/users/store.js';
import type { DwsAuthFlowServiceLike } from '../dws/authFlow.js';
import type { DwsAuthSessionRecord } from '../dws/authStore.js';
import type { DwsConnectionRecord, DwsConnectionStore } from '../dws/store.js';

export interface DwsRouterOptions {
  connectionStore?: DwsConnectionStore;
  authFlowService?: DwsAuthFlowServiceLike;
  userStore?: Pick<UserStore, 'findById'>;
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

  router.get('/dws/auth/session', async (req, res) => {
    if (!req.user?.sub || !req.user.tenantId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!options.authFlowService) {
      res.status(503).json({ error: '钉钉连接服务暂不可用' });
      return;
    }
    try {
      const session = await options.authFlowService.getLatest(req.user.tenantId, req.user.sub);
      res.json({ session: session ? toPublicAuthSession(session) : null });
    } catch {
      res.status(503).json({ error: '钉钉授权状态读取失败' });
    }
  });

  router.post('/dws/auth/session', async (req, res) => {
    if (!req.user?.sub || !req.user.tenantId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!options.authFlowService || !options.userStore) {
      res.status(503).json({ error: '钉钉连接服务暂不可用' });
      return;
    }
    const user = options.userStore.findById(req.user.sub);
    if (!user || user.disabled || user.tenantId !== req.user.tenantId) {
      res.status(403).json({ error: '当前账号无法连接钉钉' });
      return;
    }
    try {
      const session = await options.authFlowService.start(user);
      res.status(202).json({ session: toPublicAuthSession(session) });
    } catch {
      res.status(503).json({ error: '钉钉授权启动失败，请稍后重试' });
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
  return '钉钉授权已失效，请在设置中重新连接';
}

function toPublicAuthSession(row: DwsAuthSessionRecord): Record<string, unknown> {
  const expired = Date.parse(row.expiresAt) <= Date.now()
    && (row.status === 'starting' || row.status === 'awaiting_user');
  const status = expired ? 'expired' : row.status;
  return {
    sessionId: row.sessionId,
    status,
    authorizationUrl: status === 'awaiting_user' ? row.authorizationUrl ?? null : null,
    userCode: status === 'awaiting_user' ? row.userCode ?? null : null,
    expiresAt: row.expiresAt,
    message: authSessionMessage(status, row.errorMessage),
  };
}

function authSessionMessage(status: string, errorMessage: string | undefined): string {
  if (status === 'starting') return '正在生成钉钉授权页面';
  if (status === 'awaiting_user') return '请在钉钉页面确认授权';
  if (status === 'connected') return '钉钉连接成功，登录状态将由平台自动维护';
  if (status === 'expired') return '授权码已过期，请重新连接';
  return errorMessage || '钉钉授权未完成，请重试';
}
