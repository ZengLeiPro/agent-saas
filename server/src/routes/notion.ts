import { Router } from 'express';

import type { ConnectorConnectionStore } from '../connectors/connectionStore.js';
import { NOTION_CONNECTOR_ID } from '../connectors/notion.js';
import type { UserStore } from '../data/users/store.js';
import type { DwsAuthSessionRecord } from '../dws/authStore.js';
import type { NotionAuthFlowServiceLike } from '../notion/authFlow.js';

export interface NotionRouterOptions {
  connectionStore: ConnectorConnectionStore;
  authFlowService?: NotionAuthFlowServiceLike;
  userStore?: Pick<UserStore, 'findById'>;
  disconnect?: (userId: string, username: string, tenantId: string) => Promise<void>;
}

export function createNotionRouter(options: NotionRouterOptions): Router {
  const router = Router();

  router.get('/notion', (req, res) => {
    if (!req.user?.sub || !req.user.username || !req.user.tenantId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const record = options.connectionStore.get(req.user.username, NOTION_CONNECTOR_ID);
    if (!record || record.userId !== req.user.sub || record.tenantId !== req.user.tenantId) {
      res.json({ connection: null });
      return;
    }
    res.json({
      connection: {
        connectorId: NOTION_CONNECTOR_ID,
        status: record.status,
        connectedAt: record.connectedAt ?? null,
        updatedAt: record.updatedAt,
        cliCommand: 'ntn',
        envAvailable: record.status === 'connected',
      },
    });
  });

  router.get('/notion/auth/session', async (req, res) => {
    if (!req.user?.sub || !req.user.tenantId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!options.authFlowService) {
      res.status(503).json({ error: 'Notion 连接服务暂不可用' });
      return;
    }
    try {
      const session = await options.authFlowService.getLatest(req.user.tenantId, req.user.sub);
      res.json({ session: session ? toPublicAuthSession(session) : null });
    } catch {
      res.status(503).json({ error: 'Notion 授权状态读取失败' });
    }
  });

  router.post('/notion/auth/session', async (req, res) => {
    if (!req.user?.sub || !req.user.tenantId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!options.authFlowService || !options.userStore) {
      res.status(503).json({ error: 'Notion 连接服务暂不可用' });
      return;
    }
    const user = options.userStore.findById(req.user.sub);
    if (!user || user.disabled || user.tenantId !== req.user.tenantId) {
      res.status(403).json({ error: '当前账号无法连接 Notion' });
      return;
    }
    try {
      const session = await options.authFlowService.start(user);
      res.status(202).json({ session: toPublicAuthSession(session) });
    } catch {
      res.status(503).json({ error: 'Notion 授权启动失败，请稍后重试' });
    }
  });

  router.delete('/notion', async (req, res) => {
    if (!req.user?.sub || !req.user.username || !req.user.tenantId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!options.disconnect) {
      res.status(503).json({ error: 'Notion 连接服务暂不可用' });
      return;
    }
    try {
      await options.disconnect(req.user.sub, req.user.username, req.user.tenantId);
      res.status(204).send();
    } catch {
      res.status(503).json({ error: 'Notion 断开失败，请稍后重试' });
    }
  });

  return router;
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
  if (status === 'starting') return '正在生成 Notion 官方授权链接';
  if (status === 'awaiting_user') return '请打开 Notion 官方页面确认验证码';
  if (status === 'connected') return 'Notion 已连接，ntn CLI 与 SDK 已可直接使用';
  if (status === 'expired') return '授权码已过期，请重新连接';
  if (status === 'failed') return errorMessage || 'Notion 授权失败，请重试';
  return 'Notion 授权状态未知';
}
