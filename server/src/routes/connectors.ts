import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import type { SecretVault } from '../security/secretVault.js';
import type { ConnectorConnectionStore } from '../connectors/connectionStore.js';
import type { AliyunConnectorService } from '../connectors/aliyun.js';
import { isNativeRuntimeConnectorId } from '../connectors/runtimeState.js';
import type { GovernanceCredentialReader } from '../connectors/governanceCredential.js';
import {
  GITHUB_CONNECTOR_ID,
  GITHUB_TOKEN_CREDENTIAL_KEY,
  getGithubConnectionWithGovernance,
  revokePendingGithubCredentials,
  toGithubConnectionView,
} from '../connectors/github.js';
import {
  connectXCredential,
  disconnectXCredential,
  getXConnectionWithGovernance,
} from '../connectors/x.js';

const githubConnectSchema = z.object({
  token: z.string().min(1).max(20_000),
}).strict();

const xCookieSchema = z.string().min(1).max(20_000);
const xConnectSchema = z.union([
  z.object({
    authToken: xCookieSchema,
    ct0: xCookieSchema,
  }).strict(),
  z.object({
    auth_token: xCookieSchema,
    ct0: xCookieSchema,
  }).strict().transform(({ auth_token, ct0 }) => ({ authToken: auth_token, ct0 })),
]);

const aliyunConnectSchema = z.object({
  accessKeyId: z.string().min(1).max(256),
  accessKeySecret: z.string().min(1).max(512),
  regionId: z.string().min(1).max(128),
}).strict();

const runtimeStateSchema = z.object({
  runtimeEnabled: z.boolean(),
}).strict();

export interface ConnectorsRouterDeps {
  connectionStore: ConnectorConnectionStore;
  secretVault: SecretVault;
  governanceCredentialStore?: GovernanceCredentialReader;
  aliyunService?: AliyunConnectorService;
  legacyWriteGate?: {
    assertLegacyWriteAllowed(input: { actor: 'user' | 'service'; compatibilityProjection: boolean }): Promise<void>;
  };
}

function authContext(req: Request): { userId: string; username: string; tenantId: string } | undefined {
  if (!req.user?.sub || !req.user.username || !req.user.tenantId) return undefined;
  return { userId: req.user.sub, username: req.user.username, tenantId: req.user.tenantId };
}

function normalizeGithubToken(value: string): string | undefined {
  const token = value.trim().replace(/^Bearer\s+/i, '');
  const valid = /^gh[pousr]_[A-Za-z0-9_]+$/.test(token)
    || /^github_pat_[A-Za-z0-9_]+$/.test(token);
  return valid ? token : undefined;
}

export function createConnectorsRouter(deps: ConnectorsRouterDeps): Router {
  const router = Router();

  router.use(async (req, res, next) => {
    const path = req.path.toLowerCase().replace(/\/+$/, '');
    const isLegacyNativeCredentialWrite = ['/github', '/x', '/aliyun'].includes(path)
      && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    if (!isLegacyNativeCredentialWrite || !deps.legacyWriteGate) return next();
    try {
      await deps.legacyWriteGate.assertLegacyWriteAllowed({ actor: 'user', compatibilityProjection: false });
      next();
    } catch {
      res.status(409).json({
        error: '旧版 Connector/Credential 写入口已封闭，请使用治理资源 API',
        code: 'MIGRATION_LEGACY_WRITE_SEALED',
      });
    }
  });

  router.patch('/:connectorId/runtime', async (req, res) => {
    const auth = authContext(req);
    if (!auth) return res.status(401).json({ error: 'Authentication required' });
    const connectorId = req.params.connectorId;
    if (!isNativeRuntimeConnectorId(connectorId)) {
      return res.status(404).json({ error: '连接器不存在' });
    }
    const parsed = runtimeStateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    await deps.connectionStore.setRuntimeEnabled(auth.username, connectorId, parsed.data.runtimeEnabled);
    return res.json({ connectorId, runtimeEnabled: parsed.data.runtimeEnabled });
  });

  router.get('/github', async (req, res) => {
    const auth = authContext(req);
    if (!auth) return res.status(401).json({ error: 'Authentication required' });
    try {
      const connection = await getGithubConnectionWithGovernance({
        connectionStore: deps.connectionStore,
        governanceCredentialStore: deps.governanceCredentialStore,
        context: auth,
      });
      return res.json({ connection });
    } catch (error) {
      return res.status(503).json({ error: error instanceof Error ? error.message : '读取 GitHub 连接失败' });
    }
  });

  const connectGithub = async (req: Request, res: Response) => {
    const auth = authContext(req);
    if (!auth) return res.status(401).json({ error: 'Authentication required' });
    const parsed = githubConnectSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    const token = normalizeGithubToken(parsed.data.token);
    if (!token) return res.status(400).json({ error: '请输入有效的 GitHub Personal Access Token' });

    const vaultCaller = {
      actor: 'connector_proxy' as const,
      userId: auth.userId,
      tenantId: auth.tenantId,
      scopes: ['secret:connector:write'],
    };
    const secret = await deps.secretVault.putSecret(
      auth.userId,
      'connector',
      token,
      vaultCaller,
      {
        connectorId: GITHUB_CONNECTOR_ID,
        credentialKey: GITHUB_TOKEN_CREDENTIAL_KEY,
        tenantId: auth.tenantId,
        credentialOwnerId: auth.userId,
      },
    );
    try {
      const connection = await deps.connectionStore.connect({
        username: auth.username,
        userId: auth.userId,
        tenantId: auth.tenantId,
        connectorId: GITHUB_CONNECTOR_ID,
        credentialRefs: { [GITHUB_TOKEN_CREDENTIAL_KEY]: secret.id },
        capabilities: {},
        metadata: { credentialOwnerId: auth.userId },
      });
      await revokePendingGithubCredentials({
        connectionStore: deps.connectionStore,
        vault: deps.secretVault,
        username: auth.username,
      });
      await deps.connectionStore.setRuntimeEnabled(auth.username, GITHUB_CONNECTOR_ID, true);
      return res.json({ connection: toGithubConnectionView(connection, true) });
    } catch {
      await deps.secretVault.revokeSecret(secret.id, {
        actor: 'connector_proxy',
        userId: auth.userId,
        tenantId: auth.tenantId,
        scopes: ['secret:connector:revoke'],
      }).catch(() => undefined);
      return res.status(503).json({ error: 'GitHub 连接保存失败，请稍后重试' });
    }
  };

  router.post('/github', connectGithub);
  router.put('/github', connectGithub);

  router.patch('/github', (_req, res) => {
    res.status(410).json({ error: 'GitHub MCP 已迁出能力中心，请直接使用 gh、git 或 SDK' });
  });

  router.delete('/github', async (req, res) => {
    const auth = authContext(req);
    if (!auth) return res.status(401).json({ error: 'Authentication required' });
    const current = deps.connectionStore.get(auth.username, GITHUB_CONNECTOR_ID);
    if (!current || current.userId !== auth.userId || current.tenantId !== auth.tenantId) {
      return res.json({ connection: toGithubConnectionView(undefined) });
    }
    const connection = await deps.connectionStore.disconnect(auth.username, GITHUB_CONNECTOR_ID, auth.tenantId);
    await revokePendingGithubCredentials({
      connectionStore: deps.connectionStore,
      vault: deps.secretVault,
      username: auth.username,
    });
    return res.json({ connection: toGithubConnectionView(connection) });
  });

  router.get('/x', async (req, res) => {
    const auth = authContext(req);
    if (!auth) return res.status(401).json({ error: 'Authentication required' });
    try {
      const connection = await getXConnectionWithGovernance({
        connectionStore: deps.connectionStore,
        governanceCredentialStore: deps.governanceCredentialStore,
        context: auth,
      });
      return res.json({ connection });
    } catch (error) {
      return res.status(503).json({ error: error instanceof Error ? error.message : '读取 X 连接失败' });
    }
  });

  const connectX = async (req: Request, res: Response) => {
    const auth = authContext(req);
    if (!auth) return res.status(401).json({ error: 'Authentication required' });
    const parsed = xConnectSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    try {
      const connection = await connectXCredential({
        connectionStore: deps.connectionStore,
        vault: deps.secretVault,
        ...auth,
        credentials: parsed.data,
      });
      return res.json({ connection });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'X 授权保存失败';
      return res.status(400).json({ error: message });
    }
  };

  router.post('/x', connectX);
  router.put('/x', connectX);

  router.delete('/x', async (req, res) => {
    const auth = authContext(req);
    if (!auth) return res.status(401).json({ error: 'Authentication required' });
    try {
      const connection = await disconnectXCredential({
        connectionStore: deps.connectionStore,
        vault: deps.secretVault,
        ...auth,
      });
      return res.json({ connection });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'X 凭据断开失败';
      return res.status(503).json({ error: message });
    }
  });

  router.get('/aliyun', async (req, res) => {
    const auth = authContext(req);
    if (!auth) return res.status(401).json({ error: 'Authentication required' });
    if (!deps.aliyunService) return res.status(503).json({ error: '阿里云连接器未启用' });
    try {
      return res.json({ connection: await deps.aliyunService.getConnectionWithGovernance(auth) });
    } catch (error) {
      return res.status(503).json({ error: error instanceof Error ? error.message : '读取阿里云连接失败' });
    }
  });

  router.post('/aliyun', async (req, res) => {
    const auth = authContext(req);
    if (!auth) return res.status(401).json({ error: 'Authentication required' });
    if (!deps.aliyunService) return res.status(503).json({ error: '阿里云连接器未启用' });
    const parsed = aliyunConnectSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    try {
      const connection = await deps.aliyunService.connect(auth, parsed.data);
      return res.json({ connection });
    } catch (error) {
      const message = error instanceof Error ? error.message : '阿里云授权验证失败';
      return res.status(400).json({ error: message });
    }
  });

  router.delete('/aliyun', async (req, res) => {
    const auth = authContext(req);
    if (!auth) return res.status(401).json({ error: 'Authentication required' });
    if (!deps.aliyunService) return res.status(503).json({ error: '阿里云连接器未启用' });
    const connection = await deps.aliyunService.disconnect(auth);
    return res.json({ connection });
  });

  return router;
}
