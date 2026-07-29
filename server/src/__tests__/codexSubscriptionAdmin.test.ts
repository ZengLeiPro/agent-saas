import express from 'express';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseAppConfig } from '../app/config.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { createCodexSubscriptionAdminRouter } from '../routes/codexSubscriptionAdmin.js';
import { InMemorySecretVault } from '../security/secretVault.js';
import { CodexCredentialManager } from '../runtime/responses/codexCredentialManager.js';
import { CodexDeviceAuthService } from '../runtime/responses/codexOAuth.js';

function jwt(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({
    email: 'admin@example.com',
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })}.signature`;
}

function rawConfig() {
  return {
    agent: { cwd: '/tmp/agent' },
    server: { port: 3200 },
    codexSubscription: {
      enabled: false,
      endpoint: 'https://chatgpt.com/backend-api/codex/responses',
      originator: 'kaiyan-agent',
    },
    models: {
      default: 'codex/gpt',
      allowCrossGroupSwitch: false,
      groups: [{
        id: 'codex',
        name: 'Codex',
        protocol: 'responses',
        responses_transport: 'codex_subscription',
        models: [{ id: 'gpt', name: 'GPT', value: 'gpt-5.4' }],
      }],
    },
  };
}

const servers: Server[] = [];

describe('Codex subscription admin router', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    while (servers.length > 0) servers.pop()?.close();
  });

  it('完成 device authorization 后只持久化 SecretVault ref，并支持启停与撤销', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-subscription-admin-'));
    const processCwd = join(root, 'server');
    mkdirSync(processCwd, { recursive: true });
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, JSON.stringify(rawConfig(), null, 2), 'utf-8');

    const config = parseAppConfig(rawConfig());
    const vault = new InMemorySecretVault();
    const credentialFetch = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const credentialManager = new CodexCredentialManager({
      vault,
      getConfig: () => config.codexSubscription,
      fetchImpl: credentialFetch,
    });
    const oauthFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        device_auth_id: 'private-device-id',
        user_code: 'ABCD-EFGH',
        interval: 0,
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        authorization_code: 'auth-code',
        code_verifier: 'code-verifier',
        code_challenge: 'code-challenge',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: jwt('acct-access'),
        refresh_token: 'refresh-secret-value',
        id_token: jwt('acct-admin'),
        expires_in: 3600,
      }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const deviceAuthService = new CodexDeviceAuthService(oauthFetch);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = {
        sub: 'admin',
        username: 'admin',
        role: 'admin',
        tenantId: DEFAULT_TENANT_ID,
      };
      next();
    });
    app.use('/api/admin/codex-subscription', createCodexSubscriptionAdminRouter({
      processCwd,
      config,
      credentialManager,
      deviceAuthService,
    }));
    const server = app.listen(0);
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('failed to bind test server');
    const baseUrl = `http://127.0.0.1:${address.port}/api/admin/codex-subscription`;

    const prematureEnable = await fetch(baseUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(prematureEnable.status).toBe(409);

    const startResponse = await fetch(`${baseUrl}/device/start`, { method: 'POST' });
    expect(startResponse.status).toBe(201);
    const started = await startResponse.json() as { sessionId: string; userCode: string };
    expect(started.userCode).toBe('ABCD-EFGH');
    expect(started).not.toHaveProperty('deviceAuthId');

    const pollResponse = await fetch(`${baseUrl}/device/${started.sessionId}`);
    expect(pollResponse.status).toBe(200);
    const connected = await pollResponse.json() as any;
    expect(connected).toMatchObject({
      status: 'completed',
      config: { enabled: true, originator: 'kaiyan-agent' },
      credential: {
        configured: true,
        connected: true,
        accountIdHint: expect.any(String),
      },
    });
    expect(connected.credential).not.toHaveProperty('accessToken');
    expect(connected.credential).not.toHaveProperty('refreshToken');

    const written = readFileSync(configPath, 'utf-8');
    const persistedConfig = JSON.parse(written);
    expect(persistedConfig.codexSubscription).toMatchObject({
      enabled: true,
      credentialRef: expect.any(String),
    });
    expect(written).not.toContain('refresh-secret-value');
    expect(written).not.toContain(jwt('acct-admin'));

    const saveResponse = await fetch(baseUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false, originator: 'kaiyan-runtime' }),
    });
    expect(saveResponse.status).toBe(200);
    expect(await saveResponse.json()).toMatchObject({
      config: { enabled: false, originator: 'kaiyan-runtime' },
      credential: { configured: true },
    });

    const disconnectResponse = await fetch(baseUrl, { method: 'DELETE' });
    expect(disconnectResponse.status).toBe(200);
    expect(await disconnectResponse.json()).toMatchObject({
      config: { enabled: false, originator: 'kaiyan-runtime' },
      credential: { configured: false, connected: false },
    });
    expect(config.codexSubscription?.credentialRef).toBeUndefined();
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).codexSubscription.credentialRef).toBeUndefined();
    expect(credentialFetch).toHaveBeenCalledWith(
      'https://auth.openai.com/oauth/revoke',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          token: 'refresh-secret-value',
          token_type_hint: 'refresh_token',
          client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
        }),
      }),
    );
  });
});
