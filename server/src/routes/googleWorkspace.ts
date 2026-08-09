import { Router, type Request } from 'express';

import {
  GOOGLE_WORKSPACE_CONNECTOR_ID,
  type GoogleWorkspaceOAuthService,
} from '../connectors/googleWorkspace.js';
import type { UserStore } from '../data/users/store.js';

export interface GoogleWorkspaceRouterOptions {
  oauthService?: GoogleWorkspaceOAuthService;
  userStore?: Pick<UserStore, 'findById'>;
  webBaseUrl?: string;
  legacyWriteGate?: {
    assertLegacyWriteAllowed(input: { actor: 'user' | 'service'; compatibilityProjection: boolean }): Promise<void>;
  };
}

export function createGoogleWorkspaceRouter(options: GoogleWorkspaceRouterOptions): Router {
  const router = Router();

  router.use(async (req, res, next) => {
    const writesLegacyState = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
      || (req.method === 'GET' && req.path === '/oauth/callback');
    if (!writesLegacyState || !options.legacyWriteGate) return next();
    try {
      await options.legacyWriteGate.assertLegacyWriteAllowed({ actor: 'user', compatibilityProjection: false });
      next();
    } catch {
      res.status(409).json({
        error: '旧版 Google Workspace Credential 写入口已封闭，请重新从治理资源页发起连接',
        code: 'MIGRATION_LEGACY_WRITE_SEALED',
      });
    }
  });

  router.get('/google-workspace', (req, res) => {
    if (!req.user?.sub || !req.user.username || !req.user.tenantId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!options.oauthService) {
      res.json({ connection: null, available: false });
      return;
    }
    const connection = options.oauthService.connectionView(req.user.sub, req.user.username, req.user.tenantId);
    res.json({ connection: connection.status === 'connected' ? connection : null, available: true });
  });

  router.post('/google-workspace/oauth/start', async (req, res) => {
    if (!req.user?.sub || !req.user.tenantId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!options.oauthService || !options.userStore) {
      res.status(503).json({ error: 'Google Workspace 连接服务尚未配置' });
      return;
    }
    const user = options.userStore.findById(req.user.sub);
    if (!user || user.disabled || user.tenantId !== req.user.tenantId) {
      res.status(403).json({ error: '当前账号无法连接 Google Workspace' });
      return;
    }
    try {
      const started = await options.oauthService.startAuthorization(user, connectorOAuthRedirectUrl(req));
      res.json(started);
    } catch (error) {
      res.status(503).json({ error: error instanceof Error ? error.message : 'Google Workspace OAuth 启动失败' });
    }
  });

  router.get('/oauth/callback', async (req, res) => {
    const webBaseUrl = options.webBaseUrl || `${req.protocol}://${req.get('host')}`;
    if (!options.oauthService) {
      res.status(503).send(oauthResultPage(false, 'Google Workspace 连接服务尚未配置', webBaseUrl));
      return;
    }
    const state = stringQuery(req.query.state, 512);
    const code = stringQuery(req.query.code, 8192);
    const oauthError = stringQuery(req.query.error_description, 1024)
      || stringQuery(req.query.error, 256);
    if (oauthError) {
      res.status(400).send(oauthResultPage(false, oauthError, webBaseUrl));
      return;
    }
    if (!state || !code) {
      res.status(400).send(oauthResultPage(false, 'Google Workspace OAuth callback 参数不完整', webBaseUrl));
      return;
    }
    try {
      await options.oauthService.finishAuthorization({
        state,
        code,
        redirectUri: connectorOAuthRedirectUrl(req),
      });
      res.send(oauthResultPage(true, 'Google Workspace 已连接，gws CLI 可直接使用', webBaseUrl));
    } catch (error) {
      res.status(400).send(oauthResultPage(false, error instanceof Error ? error.message : 'Google Workspace OAuth 失败', webBaseUrl));
    }
  });

  router.delete('/google-workspace', async (req, res) => {
    if (!req.user?.sub || !req.user.username || !req.user.tenantId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!options.oauthService) {
      res.status(503).json({ error: 'Google Workspace 连接服务尚未配置' });
      return;
    }
    try {
      await options.oauthService.disconnect(req.user.sub, req.user.username, req.user.tenantId);
      res.status(204).send();
    } catch {
      res.status(503).json({ error: 'Google Workspace 断开失败，请稍后重试' });
    }
  });

  return router;
}

function connectorOAuthRedirectUrl(req: Request): string {
  const configured = process.env.CONNECTOR_OAUTH_CALLBACK_URL?.trim();
  const legacy = process.env.MCP_OAUTH_CALLBACK_URL?.trim();
  let raw = configured;
  if (!raw && legacy) {
    const parsedLegacy = new URL(legacy);
    parsedLegacy.pathname = '/api/connectors/oauth/callback';
    parsedLegacy.search = '';
    parsedLegacy.hash = '';
    raw = parsedLegacy.toString();
  }
  const requestHost = req.hostname;
  if (!raw && requestHost !== '127.0.0.1' && requestHost !== 'localhost') {
    throw new Error('平台管理员需先配置 CONNECTOR_OAUTH_CALLBACK_URL');
  }
  const parsed = new URL(raw || `${req.protocol}://${req.get('host')}/api/connectors/oauth/callback`);
  if (parsed.protocol !== 'https:' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error('Connector OAuth callback URL must use HTTPS');
  }
  if (parsed.pathname !== '/api/connectors/oauth/callback' || parsed.search || parsed.hash) {
    throw new Error('Connector OAuth callback URL path must be /api/connectors/oauth/callback');
  }
  return parsed.toString();
}

function stringQuery(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return undefined;
  return value;
}

function oauthResultPage(ok: boolean, message: string, webBaseUrl?: string): string {
  const safeMessage = escapeHtml(message.slice(0, 1000));
  const payload = JSON.stringify({
    type: 'connector-oauth-result',
    connectorId: GOOGLE_WORKSPACE_CONNECTOR_ID,
    ok,
    message: message.slice(0, 1000),
  }).replace(/</g, '\\u003c');
  const targetOrigin = JSON.stringify(webBaseUrl ? new URL(webBaseUrl).origin : 'null');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Google Workspace 授权</title></head><body><p>${safeMessage}</p><script>(function(){var opener=window.opener;var target=${targetOrigin};if(opener&&!opener.closed&&target!=="null"){opener.postMessage(${payload},target);window.setTimeout(function(){window.close();},500);}})();</script></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
