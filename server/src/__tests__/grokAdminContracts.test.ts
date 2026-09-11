import express from 'express';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAppConfig } from '../app/config.js';
import { InMemorySecretVault } from '../security/secretVault.js';
import { GrokCredentialManager } from '../runtime/responses/grokCredentialManager.js';
import { GrokOAuthClient } from '../runtime/responses/grokOAuthClient.js';
import { GrokDeviceAuthService } from '../runtime/responses/grokOAuth.js';
import { createGrokSubscriptionAdminRouter } from '../routes/grokSubscriptionAdmin.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { grokTokens } from './grokTestFixtures.js';
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('AGENT_SAAS_ALLOW_UNIDENTIFIED_ENVIRONMENT', '1');
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'grok-admin-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const processCwd = join(root, 'server');
  mkdirSync(processCwd);
  const path = join(root, 'config.json');
  const raw = { agent: { cwd: '/tmp/grok-admin' }, server: { port: 3200 } };
  writeFileSync(path, JSON.stringify(raw));
  const config = parseAppConfig(raw);
  const vault = new InMemorySecretVault();
  const client = new GrokOAuthClient();
  let now = 0;
  let account = 'account-a';
  vi.spyOn(client, 'start').mockResolvedValue({
    deviceCode: 'fixture-private-device',
    userCode: 'FIXTURE-CODE',
    verificationUri: 'https://auth.x.ai/activate',
    expiresAt: 3_600_000,
    intervalMs: 1000,
    clientId: 'fixture-client',
  });
  vi.spyOn(client, 'poll').mockImplementation(async () => grokTokens(account));
  vi.spyOn(client, 'revoke').mockResolvedValue(false);
  const manager = new GrokCredentialManager({
    vault,
    getConfig: () => config.grokSubscription,
    oauthClient: client,
  });
  const auth = new GrokDeviceAuthService(client, { now: () => now });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      sub: String(req.headers['x-owner'] ?? 'admin-a'),
      username: 'fixture',
      role: req.headers['x-user'] === 'ordinary' ? 'user' : 'admin',
      tenantId: req.headers['x-user'] === 'org' ? 'other-tenant' : DEFAULT_TENANT_ID,
    };
    next();
  });
  app.use(
    '/grok',
    createGrokSubscriptionAdminRouter({
      processCwd,
      config,
      credentialManager: manager,
      deviceAuthService: auth,
    }),
  );
  const server: Server = app.listen(0);
  cleanups.push(() => server.close());
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture bind');
  const base = `http://127.0.0.1:${address.port}/grok`;
  const call = async (
    route = '',
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(base + route, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  const mutate = async (route: string, method: string, body: Record<string, unknown> = {}) => {
    const state = await (await call()).json();
    return call(route, method, {
      ...body,
      expectedRevision: state.revision,
      operationId: randomUUID(),
    });
  };
  const authorize = async (id: string, replace?: string) => {
    account = id;
    const start = await call('/device/start', 'POST', replace ? { credentialRef: replace } : {});
    expect(start.status).toBe(201);
    const session = await start.json();
    now += 1000;
    const poll = await call(`/device/${session.sessionId}/poll`, 'POST', {});
    expect(await poll.json()).toMatchObject({ status: 'authorized_pending_publication' });
    return session.sessionId as string;
  };
  return { call, mutate, authorize, path, config, manager, vault, client, auth };
}
describe('Grok admin transactions T16-T23', () => {
  it('starts without a Grok root, separates external authorization from registration, and never persists tokens', async () => {
    const f = await fixture();
    expect((await (await f.call()).json()).config.enabled).toBe(false);
    expect((await f.mutate('', 'PUT', { enabled: true })).status).toBe(409);
    const session = await f.authorize('account-a');
    expect(f.config.grokSubscription).toBeUndefined();
    expect(readFileSync(f.path, 'utf8')).not.toContain('grokSubscription');
    const response = await f.mutate(`/device/${session}/complete`, 'POST');
    expect(response.status).toBe(200);
    const state = await response.json();
    expect(state.status).toBe('applied');
    expect(state.credentials).toHaveLength(1);
    expect(state.config.enabled).toBe(true);
    const again = await f.mutate(`/device/${session}/complete`, 'POST');
    expect(again.status).toBe(200);
    expect((await again.json()).credentials).toHaveLength(1);
    expect(readFileSync(f.path, 'utf8')).not.toMatch(
      /accessToken|refreshToken|fixture-access|fixture-refresh|fixture-private-device/,
    );
    expect(JSON.stringify(state)).not.toMatch(/fixture-access|fixture-refresh|account-a@example/);
  });
  it('orders the exact set, replaces in place, rejects duplicate identities and warns on unconfirmed remote revoke', async () => {
    const f = await fixture();
    for (const account of ['account-a', 'account-b']) {
      const s = await f.authorize(account);
      expect((await f.mutate(`/device/${s}/complete`, 'POST')).status).toBe(200);
    }
    const refs = f.manager.getCredentialRefs();
    for (const order of [[refs[0]], [refs[0], refs[0]], [refs[0], 'unknown-ref']])
      expect((await f.mutate('/credentials/order', 'PUT', { credentialRefs: order })).status).toBe(
        409,
      );
    expect(
      (await f.mutate('/credentials/order', 'PUT', { credentialRefs: [refs[1], refs[0]] })).status,
    ).toBe(200);
    expect(f.manager.getCredentialRefs()).toEqual([refs[1], refs[0]]);
    const duplicate = await f.authorize('account-a');
    expect((await f.mutate(`/device/${duplicate}/complete`, 'POST')).status).toBe(409);
    const reauth = await f.authorize('account-b', refs[1]);
    expect((await f.mutate(`/device/${reauth}/complete`, 'POST')).status).toBe(200);
    const next = f.manager.getCredentialRefs();
    expect(next[0]).not.toBe(refs[1]);
    expect(next[1]).toBe(refs[0]);
    expect(f.client.revoke).not.toHaveBeenCalled();
    const removal = await f.mutate(`/credentials/${next[0]}`, 'DELETE');
    expect(removal.status).toBe(200);
    expect((await removal.json()).warning).toContain('远端撤销未确认');
    expect((await f.mutate(`/credentials/${next[1]}`, 'DELETE')).status).toBe(200);
    expect(f.manager.getCredentialRefs()).toEqual([]);
    expect(f.config.grokSubscription?.enabled).toBe(false);
  });
  it('blocks ordinary/org admins, cross-owner sessions, unknown fields and stale revisions', async () => {
    const f = await fixture();
    for (const actor of ['ordinary', 'org'])
      expect((await f.call('', 'GET', undefined, { 'x-user': actor })).status).toBe(403);
    const session = await f.authorize('account-a');
    expect(
      (await f.call(`/device/${session}/complete`, 'POST', {}, { 'x-owner': 'admin-b' })).status,
    ).toBe(404);
    const before = readFileSync(f.path, 'utf8');
    expect((await f.mutate('', 'PUT', { codexSubscription: { enabled: true } })).status).toBe(400);
    expect(readFileSync(f.path, 'utf8')).toBe(before);
    expect(
      (
        await f.call('', 'PUT', {
          enabled: false,
          expectedRevision: 'stale',
          operationId: randomUUID(),
        })
      ).status,
    ).toBe(409);
    expect((await f.mutate(`/device/${session}/complete`, 'POST')).status).toBe(200);
    expect((await f.mutate('', 'DELETE')).status).toBe(200);
    expect(f.manager.getCredentialRefs()).toEqual([]);
  });
});
