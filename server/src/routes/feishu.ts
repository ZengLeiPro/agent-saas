import { Router } from 'express';

import type { UserStore } from '../data/users/store.js';
import type { FeishuAuthFlowServiceLike } from '../feishu/authFlow.js';
import type { FeishuAuthSessionRecord } from '../feishu/authStore.js';
import type { FeishuConnectionRecord, FeishuConnectionStore } from '../feishu/store.js';

export interface FeishuRouterOptions {
  connectionStore?: FeishuConnectionStore;
  authFlowService?: FeishuAuthFlowServiceLike;
  userStore?: Pick<UserStore, 'findById'>;
}

export function createFeishuRouter(options: FeishuRouterOptions): Router {
  const router = Router();

  router.get('/feishu/connections', async (req, res) => {
    if (!req.user?.sub || !req.user.tenantId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!options.connectionStore) {
      res.status(503).json({ error: '飞书连接状态服务暂不可用' });
      return;
    }
    try {
      const rows = await options.connectionStore.listForUser(req.user.tenantId, req.user.sub);
      res.json({ connections: rows.map(toPublicConnection) });
    } catch {
      res.status(503).json({ error: '飞书连接状态读取失败' });
    }
  });

  router.get('/feishu/auth/session', async (req, res) => {
    if (!req.user?.sub || !req.user.tenantId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!options.authFlowService) {
      res.status(503).json({ error: '飞书连接服务尚未配置' });
      return;
    }
    try {
      const session = await options.authFlowService.getLatest(req.user.tenantId, req.user.sub);
      res.json({ session: session ? toPublicAuthSession(session) : null });
    } catch {
      res.status(503).json({ error: '飞书授权状态读取失败' });
    }
  });

  router.post('/feishu/auth/session', async (req, res) => {
    if (!req.user?.sub || !req.user.tenantId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!options.authFlowService || !options.userStore) {
      res.status(503).json({ error: '飞书连接服务尚未配置' });
      return;
    }
    const user = options.userStore.findById(req.user.sub);
    if (!user || user.disabled || user.tenantId !== req.user.tenantId) {
      res.status(403).json({ error: '当前账号无法连接飞书' });
      return;
    }
    try {
      const session = await options.authFlowService.start(user);
      res.status(202).json({ session: toPublicAuthSession(session) });
    } catch {
      res.status(503).json({ error: '飞书授权启动失败，请稍后重试' });
    }
  });

  return router;
}

function toPublicConnection(row: FeishuConnectionRecord): Record<string, unknown> {
  return {
    profileId: row.profileId,
    userName: row.userName ?? null,
    status: row.connectionStatus,
    authenticated: row.authenticated ?? null,
    verified: row.verified ?? null,
    refreshExpiresAt: row.refreshExpiresAt ?? null,
    lastCheckedAt: row.lastCheckedAt ?? null,
    nextCheckAt: row.nextCheckAt,
    message: publicStatusMessage(row),
  };
}

function publicStatusMessage(row: FeishuConnectionRecord): string {
  if (row.connectionStatus === 'connected') return '登录状态由平台自动维护，无需定期重新授权';
  if (row.connectionStatus === 'pending') return '已完成飞书授权，平台正在执行首次检测';
  if (row.connectionStatus === 'error') return '自动检测暂时失败，平台会继续重试';
  return '飞书授权已失效，请在能力中心的「连接器」页重新连接';
}

function toPublicAuthSession(row: FeishuAuthSessionRecord): Record<string, unknown> {
  const expired = Date.parse(row.expiresAt) <= Date.now()
    && (row.status === 'starting' || row.status === 'awaiting_user');
  const status = expired ? 'expired' : row.status;
  return {
    sessionId: row.sessionId,
    status,
    authorizationUrl: status === 'awaiting_user' ? row.authorizationUrl ?? null : null,
    expiresAt: row.expiresAt,
    message: authSessionMessage(status, row.errorMessage),
  };
}

function authSessionMessage(status: string, errorMessage: string | undefined): string {
  if (status === 'starting') return '正在生成飞书授权页面';
  if (status === 'awaiting_user') return '请在飞书官方页面确认授权';
  if (status === 'connected') return '飞书连接成功，登录状态将由平台自动维护';
  if (status === 'expired') return '授权链接已过期，请重新连接';
  return errorMessage || '飞书授权未完成，请重试';
}
