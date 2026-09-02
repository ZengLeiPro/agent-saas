import { Router, type Request } from 'express';

import {
  GOOGLE_WORKSPACE_CONNECTOR_ID,
  type GoogleWorkspaceOAuthService,
} from '../connectors/googleWorkspace.js';
import type { UserStore } from '../data/users/store.js';
import { nativeOAuthStartBindingSchema, type NativeOAuthHandoffStore } from '../connectors/nativeOAuthHandoff.js';

export interface GoogleWorkspaceRouterOptions {
  oauthService?: GoogleWorkspaceOAuthService;
  userStore?: Pick<UserStore, 'findById'>;
  webBaseUrl?: string;
  nativeOAuthHandoff?: NativeOAuthHandoffStore;
  recordOAuthGrant?: (input: {
    grantId: string; tenantId: string; subjectUserId: string; provider: string; connectorId: string;
    status: 'active'; scopeSummary: string[]; approvedAt: string;
    action: 'approved'; purpose: string; actorUserId: string;
  }) => Promise<unknown>;
  revokeOAuthGrant?: (input: {
    grantId: string; tenantId: string; subjectUserId: string; purpose: string; actorUserId: string;
  }) => Promise<unknown>;
  ensureOAuthGrant?: (input: {
    userId: string; username: string; tenantId: string;
  }) => Promise<{ grantId: string } | undefined>;
  legacyWriteGate?: {
    assertLegacyWriteAllowed(input: { actor: 'user' | 'service'; compatibilityProjection: boolean }): Promise<void>;
  };
}

const googleOAuthStartSchema = nativeOAuthStartBindingSchema.optional();

export function createGoogleWorkspaceRouter(options: GoogleWorkspaceRouterOptions): Router {
  const router = Router();

  router.use(async (req, res, next) => {
    const governedOAuthFlow = (req.method === 'GET' && req.path === '/oauth/callback')
      || (req.method === 'POST' && req.path === '/google-workspace/oauth/start')
      || (req.method === 'POST' && req.path === '/google-workspace/oauth-grant/ensure')
      || (req.method === 'POST' && req.path === '/google-workspace/unverified-disconnect');
    const writesLegacyState = !governedOAuthFlow && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
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

  router.post('/google-workspace/oauth-grant/ensure', async (req, res) => {
    if (!req.user?.sub || !req.user.username || !req.user.tenantId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!options.ensureOAuthGrant) {
      res.status(503).json({ error: 'Google Workspace OAuth Grant 权威尚未配置' });
      return;
    }
    try {
      const grant = await options.ensureOAuthGrant({
        userId: req.user.sub, username: req.user.username, tenantId: req.user.tenantId,
      });
      if (!grant) {
        res.status(409).json({
          error: 'Google Workspace 连接缺少可验证的授权范围',
          code: 'GOOGLE_WORKSPACE_SCOPE_UNVERIFIABLE',
        });
        return;
      }
      res.json({ grantId: grant.grantId });
    } catch (error) {
      res.status(503).json({ error: error instanceof Error ? error.message : 'Google Workspace OAuth Grant 补齐失败' });
    }
  });

  router.post('/google-workspace/unverified-disconnect', async (req, res) => {
    if (!req.user?.sub || !req.user.username || !req.user.tenantId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!options.oauthService || !options.ensureOAuthGrant) {
      res.status(503).json({ error: 'Google Workspace 连接服务或 OAuth Grant 权威尚未配置' });
      return;
    }
    try {
      const grant = await options.ensureOAuthGrant({
        userId: req.user.sub, username: req.user.username, tenantId: req.user.tenantId,
      });
      if (grant) {
        res.status(409).json({
          error: '请通过治理 OAuth Grant 签名预览撤销授权',
          code: 'OAUTH_GRANT_SIGNED_REVOCATION_REQUIRED',
        });
        return;
      }
      await options.oauthService.disconnect(req.user.sub, req.user.username, req.user.tenantId);
      res.status(204).end();
    } catch (error) {
      res.status(503).json({ error: error instanceof Error ? error.message : 'Google Workspace 断开失败' });
    }
  });

  router.post('/google-workspace/oauth/start', async (req, res) => {
    if (!req.user?.sub || !req.user.tenantId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!options.oauthService || !options.userStore || !options.recordOAuthGrant) {
      res.status(503).json({ error: 'Google Workspace 连接服务或 OAuth Grant 权威尚未配置' });
      return;
    }
    const nativeParsed = googleOAuthStartSchema.safeParse(req.body && Object.keys(req.body).length ? req.body : undefined);
    if (!nativeParsed.success) { res.status(400).json({ error: 'Invalid native OAuth transaction binding' }); return; }
    const nativeBinding = nativeParsed.data;
    if (nativeBinding && !options.nativeOAuthHandoff) {
      res.status(503).json({ error: 'Native OAuth handoff is not configured', code: 'NATIVE_OAUTH_HANDOFF_UNAVAILABLE' });
      return;
    }
    const user = options.userStore.findById(req.user.sub);
    if (!user || user.disabled || user.tenantId !== req.user.tenantId) {
      res.status(403).json({ error: '当前账号无法连接 Google Workspace' });
      return;
    }
    try {
      const started = await options.oauthService.startAuthorization(user, connectorOAuthRedirectUrl(req));
      if (nativeBinding) {
        try {
          await options.nativeOAuthHandoff!.begin({
            providerState: started.state, userId: user.id, tenantId: user.tenantId,
            connectorId: GOOGLE_WORKSPACE_CONNECTOR_ID, deviceId: nativeBinding.nativeDeviceId,
            clientState: nativeBinding.nativeState, pkceChallenge: nativeBinding.nativePkceChallenge,
            provider: nativeBinding.nativeProvider, redirectUri: nativeBinding.nativeRedirectUri,
            identityGeneration: nativeBinding.nativeIdentityGeneration, createdAt: nativeBinding.nativeCreatedAt,
          });
        } catch (error) {
          await options.oauthService.cancelUser(user.id);
          throw error;
        }
      }
      res.json(started);
    } catch (error) {
      res.status(503).json({ error: error instanceof Error ? error.message : 'Google Workspace OAuth 启动失败' });
    }
  });

  router.get('/oauth/callback', async (req, res) => {
    const webBaseUrl = options.webBaseUrl || `${req.protocol}://${req.get('host')}`;
    const state = stringQuery(req.query.state, 512);
    if (!options.oauthService || !options.recordOAuthGrant || !options.revokeOAuthGrant) {
      const nativeRedirect = state ? await options.nativeOAuthHandoff?.complete(state, {
        status: 'failed', errorCode: 'OAUTH_SERVICE_UNAVAILABLE',
      }).catch(() => null) : null;
      if (nativeRedirect) return res.redirect(302, nativeRedirect);
      res.status(503).send(oauthResultPage(false, 'Google Workspace 连接服务或 OAuth Grant 权威尚未配置', webBaseUrl));
      return;
    }
    const code = stringQuery(req.query.code, 8192);
    const oauthError = stringQuery(req.query.error_description, 1024)
      || stringQuery(req.query.error, 256);
    if (oauthError && code) {
      const rejected = state ? await options.oauthService.rejectAuthorization(state).catch(() => false) : false;
      const nativeRedirect = rejected ? await options.nativeOAuthHandoff?.complete(state!, {
        status: 'failed', errorCode: 'OAUTH_CALLBACK_AMBIGUOUS',
      }).catch(() => null) : null;
      if (nativeRedirect) return res.redirect(302, nativeRedirect);
      res.status(400).send(oauthResultPage(false, 'OAuth callback code/error 参数互斥', webBaseUrl));
      return;
    }
    if (oauthError) {
      const rejected = state ? await options.oauthService.rejectAuthorization(state).catch(() => false) : false;
      const nativeRedirect = rejected ? await options.nativeOAuthHandoff?.complete(state!, {
        status: 'failed', errorCode: 'OAUTH_AUTHORIZATION_FAILED',
      }).catch(() => null) : null;
      if (nativeRedirect) return res.redirect(302, nativeRedirect);
      res.status(400).send(oauthResultPage(false, oauthError, webBaseUrl));
      return;
    }
    if (!state || !code) {
      const rejected = state ? await options.oauthService.rejectAuthorization(state).catch(() => false) : false;
      const nativeRedirect = rejected ? await options.nativeOAuthHandoff?.complete(state!, {
        status: 'failed', errorCode: 'OAUTH_CALLBACK_INCOMPLETE',
      }).catch(() => null) : null;
      if (nativeRedirect) return res.redirect(302, nativeRedirect);
      res.status(400).send(oauthResultPage(false, 'Google Workspace OAuth callback 参数不完整', webBaseUrl));
      return;
    }
    try {
      const result = await options.oauthService.finishAuthorization({
        state,
        code,
        redirectUri: connectorOAuthRedirectUrl(req),
        recordGrant: async ({ user, scopeSummary }, previousScopes) => {
          const grantId = `google-workspace:${user.tenantId}:${user.id}`;
          const recordActiveGrant = async (scopes: string[]) => {
            await options.recordOAuthGrant?.({
              grantId,
              tenantId: user.tenantId,
              subjectUserId: user.id,
              provider: 'google',
              connectorId: GOOGLE_WORKSPACE_CONNECTOR_ID,
              status: 'active',
              scopeSummary: scopes,
              approvedAt: new Date().toISOString(),
              action: 'approved',
              purpose: 'google_workspace_connect',
              actorUserId: user.id,
            });
          };
          await recordActiveGrant(scopeSummary);
          return async () => {
            if (previousScopes.length > 0) {
              await recordActiveGrant(previousScopes);
              return;
            }
            await options.revokeOAuthGrant?.({
              grantId,
              tenantId: user.tenantId,
              subjectUserId: user.id,
              purpose: 'google_workspace_connect_compensation',
              actorUserId: user.id,
            });
          };
        },
      });
      let nativeRedirect: string | null | undefined;
      try {
        nativeRedirect = await options.nativeOAuthHandoff?.complete(state, { status: 'succeeded' });
      } catch {
        return res.status(202).send(oauthResultPage(
          true,
          'Google Workspace 已连接，但 App 回跳交付暂时失败；请返回 App 的连接与授权页面刷新状态',
          webBaseUrl,
        ));
      }
      if (nativeRedirect) return res.redirect(302, nativeRedirect);
      res.send(oauthResultPage(true, 'Google Workspace 已连接，gws CLI 可直接使用', webBaseUrl));
    } catch (error) {
      const nativeRedirect = await options.nativeOAuthHandoff?.complete(state, {
        status: 'failed', errorCode: 'OAUTH_CALLBACK_FAILED',
      }).catch(() => null);
      if (nativeRedirect) return res.redirect(302, nativeRedirect);
      res.status(400).send(oauthResultPage(
        false,
        `${error instanceof Error ? error.message : 'Google Workspace OAuth 失败'}；若授权已在 Google 完成，请返回连接与授权页面刷新状态`,
        webBaseUrl,
      ));
    }
  });

  router.delete('/google-workspace', (req, res) => {
    if (!req.user?.sub || !req.user.username || !req.user.tenantId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    res.status(503).json({
      error: '请通过治理 OAuth Grant 签名预览撤销授权',
      code: 'OAUTH_GRANT_SIGNED_REVOCATION_REQUIRED',
    });
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
  const fallback = JSON.stringify(webBaseUrl ? new URL('/settings/connections', webBaseUrl).toString() : '/settings/connections');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Google Workspace 授权</title></head><body><p>${safeMessage}</p><script>(function(){var opener=window.opener;var target=${targetOrigin};var fallback=${fallback};if(opener&&!opener.closed&&target!=="null"){opener.postMessage(${payload},target);window.setTimeout(function(){window.close();window.setTimeout(function(){location.replace(fallback);},300);},500);return;}location.replace(fallback);})();</script></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
