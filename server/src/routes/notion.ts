import { Router } from 'express';

import {
  NOTION_LOCAL_DISCONNECT_NOTICE,
  type NotionConnectionView,
} from '../connectors/notion.js';
import type { ConnectorConnectionStore } from '../connectors/connectionStore.js';
import type { UserStore } from '../data/users/store.js';
import type { NotionAuthFlowServiceLike } from '../notion/authFlow.js';

export interface NotionRouterOptions {
  connectionStore: ConnectorConnectionStore;
  userStore: UserStore;
  authFlowService?: NotionAuthFlowServiceLike;
  getConnection?: (identity: {
    userId: string;
    username: string;
    tenantId: string;
  }) => Promise<NotionConnectionView>;
  disconnect?: (
    userId: string,
    username: string,
    tenantId: string,
  ) => Promise<unknown>;
  available: boolean;
  legacyWriteGate?: {
    assertLegacyWriteAllowed(input: { actor: 'user' | 'service'; compatibilityProjection: boolean }): Promise<void>;
  };
}

export function createNotionRouter(options: NotionRouterOptions): Router {
  const router = Router();

  router.use(async (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || !options.legacyWriteGate) return next();
    try {
      await options.legacyWriteGate.assertLegacyWriteAllowed({ actor: 'user', compatibilityProjection: false });
      next();
    } catch {
      res.status(409).json({
        error: '旧版 Notion Credential 写入口已封闭，请使用治理资源 API',
        code: 'MIGRATION_LEGACY_WRITE_SEALED',
      });
    }
  });

  router.get('/connectors/notion', async (req, res) => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!options.available || !options.getConnection) {
      res.json({ available: false, connection: disconnectedView() });
      return;
    }
    try {
      const connection = await options.getConnection({
        userId: req.user.sub,
        username: req.user.username,
        tenantId: req.user.tenantId,
      });
      res.json({ available: true, connection });
    } catch {
      res.status(503).json({ error: 'Notion 连接状态暂时不可用' });
    }
  });

  router.get('/connectors/notion/auth/session', async (req, res) => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!options.authFlowService) {
      res.json({ available: false, session: null });
      return;
    }
    try {
      const session = await options.authFlowService.getLatest(req.user.tenantId, req.user.sub);
      res.json({ available: true, session: sanitizeSession(session) });
    } catch {
      res.status(500).json({ error: 'Notion 授权状态读取失败' });
    }
  });

  router.post('/connectors/notion/auth/session', async (req, res) => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!options.authFlowService) {
      res.status(503).json({ error: 'Notion 官方授权当前不可用' });
      return;
    }
    const current = options.userStore.findById(req.user.sub);
    if (
      !current
      || current.disabled
      || current.username !== req.user.username
      || current.tenantId !== req.user.tenantId
    ) {
      res.status(403).json({ error: '用户状态已失效' });
      return;
    }
    try {
      const session = await options.authFlowService.start(current);
      res.status(202).json({ session: sanitizeSession(session) });
    } catch {
      res.status(500).json({ error: 'Notion 授权启动失败' });
    }
  });

  router.delete('/connectors/notion', async (req, res) => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!options.disconnect) {
      res.status(503).json({ error: 'Notion 连接服务尚未配置' });
      return;
    }
    try {
      await options.authFlowService?.cancelUser?.(req.user.tenantId, req.user.sub);
      const result = await options.disconnect(req.user.sub, req.user.username, req.user.tenantId);
      res.json({
        ...(isRecord(result) ? result : {}),
        providerRevoked: false,
        notice: NOTION_LOCAL_DISCONNECT_NOTICE,
      });
    } catch {
      res.status(500).json({ error: 'Notion 本地断开失败' });
    }
  });

  return router;
}

function disconnectedView(): NotionConnectionView {
  return {
    connectorId: 'notion',
    status: 'disconnected',
    disconnectNotice: NOTION_LOCAL_DISCONNECT_NOTICE,
  };
}

function sanitizeSession(session: Awaited<ReturnType<NotionAuthFlowServiceLike['getLatest']>>) {
  if (!session) return null;
  const expired = Date.parse(session.expiresAt) <= Date.now()
    && (session.status === 'starting' || session.status === 'awaiting_user');
  const status = expired ? 'expired' : session.status;
  return {
    sessionId: session.sessionId,
    status,
    authorizationUrl: status === 'awaiting_user' ? session.authorizationUrl ?? null : null,
    userCode: status === 'awaiting_user' ? session.userCode ?? null : null,
    expiresAt: session.expiresAt,
    message: authSessionMessage(status, session.errorMessage),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
