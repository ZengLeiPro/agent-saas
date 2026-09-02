import express from 'express';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
      websocketEnabled: false,
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
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('AGENT_SAAS_ALLOW_UNIDENTIFIED_ENVIRONMENT', '1');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
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
    const closeWebSockets = vi.fn();

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
      closeWebSockets,
    }));
    const server = app.listen(0);
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('failed to bind test server');
    const baseUrl = `http://127.0.0.1:${address.port}/api/admin/codex-subscription`;

    for (const invalidCooldown of ['60', null, 1.5]) {
      const invalidCooldownResponse = await fetch(baseUrl, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ quotaCooldownMinutes: invalidCooldown }),
      });
      expect(invalidCooldownResponse.status).toBe(400);
    }

    const prematureEnable = await fetch(baseUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(prematureEnable.status).toBe(409);
    expect(config.codexSubscription?.quotaCooldownMinutes).toBe(60);

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
      config: { enabled: true, websocketEnabled: false, originator: 'kaiyan-agent' },
      credential: {
        configured: true,
        connected: true,
        accountIdHint: expect.any(String),
      },
      runtime: {
        requestWindow: {
          limit: 50,
          sampleCount: 0,
        },
        wireWindow: {
          limit: 50,
          sampleCount: 0,
        },
        oauth: {},
      },
    });
    expect(connected.credential).not.toHaveProperty('accessToken');
    expect(connected.credential).not.toHaveProperty('refreshToken');
    expect(closeWebSockets).toHaveBeenCalledTimes(1);

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
      body: JSON.stringify({
        enabled: false,
        websocketEnabled: true,
        quotaCooldownMinutes: 90,
        originator: 'kaiyan-runtime',
      }),
    });
    expect(saveResponse.status).toBe(200);
    expect(await saveResponse.json()).toMatchObject({
      config: {
        enabled: false,
        websocketEnabled: false,
        quotaCooldownMinutes: 90,
        originator: 'kaiyan-agent',
      },
      credential: { configured: true },
    });
    expect(closeWebSockets).toHaveBeenCalledTimes(2);

    const cooldownOnlyResponse = await fetch(baseUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quotaCooldownMinutes: 120 }),
    });
    expect(cooldownOnlyResponse.status).toBe(200);
    expect(await cooldownOnlyResponse.json()).toMatchObject({
      config: { quotaCooldownMinutes: 120 },
    });
    expect(closeWebSockets).toHaveBeenCalledTimes(2);

    const disconnectResponse = await fetch(baseUrl, { method: 'DELETE' });
    expect(disconnectResponse.status).toBe(200);
    expect(await disconnectResponse.json()).toMatchObject({
      config: { enabled: false, websocketEnabled: false, originator: 'kaiyan-agent' },
      credential: { configured: false, connected: false },
    });
    expect(config.codexSubscription?.credentialRef).toBeUndefined();
    expect(closeWebSockets).toHaveBeenCalledTimes(3);
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

  it('支持追加、排序和删除多个 Codex 授权账号', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-subscription-admin-multi-'));
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
        device_auth_id: 'device-one', user_code: 'ONE-0001', interval: 0,
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        authorization_code: 'auth-one', code_verifier: 'verifier-one', code_challenge: 'challenge-one',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: jwt('acct-one'), refresh_token: 'refresh-one', id_token: jwt('acct-one'), expires_in: 3600,
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        device_auth_id: 'device-two', user_code: 'TWO-0002', interval: 0,
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        authorization_code: 'auth-two', code_verifier: 'verifier-two', code_challenge: 'challenge-two',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: jwt('acct-two'), refresh_token: 'refresh-two', id_token: jwt('acct-two'), expires_in: 3600,
      }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const deviceAuthService = new CodexDeviceAuthService(oauthFetch);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).user = {
        sub: 'admin', username: 'admin', role: 'admin', tenantId: DEFAULT_TENANT_ID,
      };
      next();
    });
    const closeWebSockets = vi.fn();
    app.use('/api/admin/codex-subscription', createCodexSubscriptionAdminRouter({
      processCwd, config, credentialManager, deviceAuthService, closeWebSockets,
    }));
    const server = app.listen(0);
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('failed to bind test server');
    const baseUrl = `http://127.0.0.1:${address.port}/api/admin/codex-subscription`;

    const startOne = await fetch(`${baseUrl}/device/start`, { method: 'POST' });
    expect(startOne.status).toBe(201);
    const sessionOne = await startOne.json() as { sessionId: string };
    const completeOne = await fetch(`${baseUrl}/device/${sessionOne.sessionId}`);
    expect(completeOne.status).toBe(200);
    const oneState = await completeOne.json() as any;
    expect(oneState.credentials).toHaveLength(1);

    const startTwo = await fetch(`${baseUrl}/device/start`, { method: 'POST' });
    expect(startTwo.status).toBe(201);
    const sessionTwo = await startTwo.json() as { sessionId: string };
    const completeTwo = await fetch(`${baseUrl}/device/${sessionTwo.sessionId}`);
    expect(completeTwo.status).toBe(200);
    const twoState = await completeTwo.json() as any;
    expect(twoState.credentials).toHaveLength(2);
    const firstId = twoState.credentials[0].id as string;
    const secondId = twoState.credentials[1].id as string;

    const reorder = await fetch(`${baseUrl}/credentials/order`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credentialRefs: [secondId, firstId] }),
    });
    expect(reorder.status).toBe(200);
    expect((await reorder.json() as any).credentials.map((item: any) => item.id))
      .toEqual([secondId, firstId]);
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).codexSubscription).toMatchObject({
      credentialRef: secondId,
      credentialRefs: [secondId, firstId],
    });
    expect(closeWebSockets).toHaveBeenCalledTimes(2);

    const remove = await fetch(`${baseUrl}/credentials/${encodeURIComponent(secondId)}`, { method: 'DELETE' });
    expect(remove.status).toBe(200);
    const remaining = await remove.json() as any;
    expect(remaining.credentials).toHaveLength(1);
    expect(remaining.credentials[0].id).toBe(firstId);
    expect(closeWebSockets).toHaveBeenCalledTimes(3);
  });
});
