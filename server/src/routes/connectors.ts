import { Router, type Request } from 'express';
import { z } from 'zod';

import type { McpClientManager } from '../mcp/clientManager.js';
import type { McpConfigStore } from '../data/mcpConfig.js';
import type { SecretVault } from '../security/secretVault.js';
import type { ConnectorConnectionStore } from '../connectors/connectionStore.js';
import {
  GITHUB_CONNECTOR_ID,
  GITHUB_MCP_CAPABILITY,
  GITHUB_TOKEN_CREDENTIAL_KEY,
  revokePendingGithubCredentials,
  toGithubConnectionView,
} from '../connectors/github.js';

const githubConnectSchema = z.object({
  token: z.string().min(1).max(20_000),
  mcpEnabled: z.boolean().optional(),
}).strict();
const githubCapabilitySchema = z.object({ mcpEnabled: z.boolean() }).strict();

export interface ConnectorsRouterDeps {
  connectionStore: ConnectorConnectionStore;
  mcpConfigStore: McpConfigStore;
  mcpClientManager: McpClientManager;
  secretVault: SecretVault;
}

function authContext(req: Request): { username: string; tenantId: string } | undefined {
  if (!req.user?.username || !req.user.tenantId) return undefined;
  return { username: req.user.username, tenantId: req.user.tenantId };
}

function normalizeGithubToken(value: string): string | undefined {
  const token = value.trim().replace(/^Bearer\s+/i, '');
  const valid = /^gh[pousr]_[A-Za-z0-9_]+$/.test(token)
    || /^github_pat_[A-Za-z0-9_]+$/.test(token);
  return valid ? token : undefined;
}

async function syncGithubMcp(
  deps: ConnectorsRouterDeps,
  username: string,
  tenantId: string,
  enabled: boolean,
): Promise<void> {
  const current = deps.mcpConfigStore.getUserConfig(username).enabledServers;
  const next = enabled
    ? Array.from(new Set([...current, GITHUB_CONNECTOR_ID]))
    : current.filter(id => id !== GITHUB_CONNECTOR_ID);
  await deps.mcpConfigStore.setUserEnabledServers(username, next, tenantId);
  await deps.mcpClientManager.invalidateUser(username);
}

export function createConnectorsRouter(deps: ConnectorsRouterDeps): Router {
  const router = Router();

  router.get('/github', (req, res) => {
    const auth = authContext(req);
    if (!auth) return res.status(401).json({ error: 'Authentication required' });
    res.json({ connection: toGithubConnectionView(deps.connectionStore.get(auth.username, GITHUB_CONNECTOR_ID)) });
  });

  router.put('/github', async (req, res) => {
    const auth = authContext(req);
    if (!auth) return res.status(401).json({ error: 'Authentication required' });
    const parsed = githubConnectSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    const token = normalizeGithubToken(parsed.data.token);
    if (!token) return res.status(400).json({ error: '请输入有效的 GitHub Personal Access Token' });

    const previous = deps.connectionStore.get(auth.username, GITHUB_CONNECTOR_ID);
    const mcpEnabled = parsed.data.mcpEnabled ?? previous?.capabilities[GITHUB_MCP_CAPABILITY] ?? true;
    const secret = await deps.secretVault.putSecret(auth.username, 'connector', token, {
      connectorId: GITHUB_CONNECTOR_ID,
      credentialKey: GITHUB_TOKEN_CREDENTIAL_KEY,
    });
    const connection = await deps.connectionStore.connect({
      username: auth.username,
      tenantId: auth.tenantId,
      connectorId: GITHUB_CONNECTOR_ID,
      credentialRefs: { [GITHUB_TOKEN_CREDENTIAL_KEY]: secret.id },
      capabilities: { [GITHUB_MCP_CAPABILITY]: mcpEnabled },
    });
    await deps.mcpConfigStore.clearUserSecretRef(
      auth.username,
      GITHUB_CONNECTOR_ID,
      GITHUB_TOKEN_CREDENTIAL_KEY,
    );
    await syncGithubMcp(deps, auth.username, auth.tenantId, mcpEnabled);
    await revokePendingGithubCredentials({
      connectionStore: deps.connectionStore,
      vault: deps.secretVault,
      username: auth.username,
    });
    res.json({ connection: toGithubConnectionView(connection) });
  });

  router.patch('/github', async (req, res) => {
    const auth = authContext(req);
    if (!auth) return res.status(401).json({ error: 'Authentication required' });
    const parsed = githubCapabilitySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    const current = deps.connectionStore.get(auth.username, GITHUB_CONNECTOR_ID);
    if (!current || current.status !== 'connected') return res.status(409).json({ error: '请先连接 GitHub' });
    const connection = await deps.connectionStore.setCapability(
      auth.username,
      GITHUB_CONNECTOR_ID,
      GITHUB_MCP_CAPABILITY,
      parsed.data.mcpEnabled,
    );
    await syncGithubMcp(deps, auth.username, auth.tenantId, parsed.data.mcpEnabled);
    res.json({ connection: toGithubConnectionView(connection) });
  });

  router.delete('/github', async (req, res) => {
    const auth = authContext(req);
    if (!auth) return res.status(401).json({ error: 'Authentication required' });
    const connection = await deps.connectionStore.disconnect(auth.username, GITHUB_CONNECTOR_ID, auth.tenantId);
    await deps.mcpConfigStore.clearUserSecretRef(
      auth.username,
      GITHUB_CONNECTOR_ID,
      GITHUB_TOKEN_CREDENTIAL_KEY,
    );
    await syncGithubMcp(deps, auth.username, auth.tenantId, false);
    await revokePendingGithubCredentials({
      connectionStore: deps.connectionStore,
      vault: deps.secretVault,
      username: auth.username,
    });
    res.json({ connection: toGithubConnectionView(connection) });
  });

  return router;
}
