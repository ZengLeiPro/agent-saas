import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import type { SecretVault } from '../security/secretVault.js';
import type { ConnectorConnectionStore } from '../connectors/connectionStore.js';
import {
  GITHUB_CONNECTOR_ID,
  GITHUB_TOKEN_CREDENTIAL_KEY,
  revokePendingGithubCredentials,
  toGithubConnectionView,
} from '../connectors/github.js';

const githubConnectSchema = z.object({
  token: z.string().min(1).max(20_000),
}).strict();

export interface ConnectorsRouterDeps {
  connectionStore: ConnectorConnectionStore;
  secretVault: SecretVault;
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

  router.get('/github', (req, res) => {
    const auth = authContext(req);
    if (!auth) return res.status(401).json({ error: 'Authentication required' });
    const record = deps.connectionStore.get(auth.username, GITHUB_CONNECTOR_ID);
    const owned = record?.userId === auth.userId && record.tenantId === auth.tenantId ? record : undefined;
    res.json({ connection: toGithubConnectionView(owned) });
  });

  const connectGithub = async (req: Request, res: Response) => {
    const auth = authContext(req);
    if (!auth) return res.status(401).json({ error: 'Authentication required' });
    const parsed = githubConnectSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    const token = normalizeGithubToken(parsed.data.token);
    if (!token) return res.status(400).json({ error: '请输入有效的 GitHub Personal Access Token' });

    const secret = await deps.secretVault.putSecret(auth.username, 'connector', token, {
      connectorId: GITHUB_CONNECTOR_ID,
      credentialKey: GITHUB_TOKEN_CREDENTIAL_KEY,
      tenantId: auth.tenantId,
    });
    try {
      const connection = await deps.connectionStore.connect({
        username: auth.username,
        userId: auth.userId,
        tenantId: auth.tenantId,
        connectorId: GITHUB_CONNECTOR_ID,
        credentialRefs: { [GITHUB_TOKEN_CREDENTIAL_KEY]: secret.id },
        capabilities: {},
      });
      await revokePendingGithubCredentials({
        connectionStore: deps.connectionStore,
        vault: deps.secretVault,
        username: auth.username,
      });
      return res.json({ connection: toGithubConnectionView(connection) });
    } catch {
      await deps.secretVault.revokeSecret(secret.id, {
        actor: 'connector_proxy',
        userId: auth.username,
        tenantId: auth.tenantId,
        scopes: ['secret:connector:read', 'secret:mcp:read'],
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

  return router;
}
