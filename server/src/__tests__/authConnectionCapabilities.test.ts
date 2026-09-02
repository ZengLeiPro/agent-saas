import express from 'express';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuthConnectionCapabilityRouter, type AuthConnectionCapabilityRouterOptions } from '../routes/authConnectionCapabilities.js';
import { initAuditLog } from '../data/login-logs/index.js';

const servers: Server[] = [];
const dirs: string[] = [];
async function waitForAudit(path: string, marker: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { const content = readFileSync(path, 'utf8'); if (content.includes(marker)) return content; } catch { /* fire-and-forget write not started yet */ }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return (() => { try { return readFileSync(path, 'utf8'); } catch { return ''; } })();
}
async function harness(patch: Partial<AuthConnectionCapabilityRouterOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'm30-03-')); dirs.push(dir); initAuditLog(join(dir, 'audit.jsonl'));
  const options: AuthConnectionCapabilityRouterOptions = {
    providerConfigured: () => true, credentialState: () => 'valid', tenantAllowed: () => true,
    callbackDomainConfigured: () => true, ssoAvailable: () => true, serverDegraded: () => false,
    now: () => new Date('2026-08-30T00:00:00.000Z'), ...patch,
  };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { sub: 'u1', username: 'alice', role: 'user', tenantId: 't1' }; next(); });
  app.use('/api/auth', createAuthConnectionCapabilityRouter(options));
  const server = await new Promise<Server>(resolve => { const current = app.listen(0, '127.0.0.1', () => resolve(current)); });
  servers.push(server); const address = server.address(); const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  return { dir, get: (query = '') => fetch(`${base}/api/auth/capabilities/status?provider=google-workspace&channel=mobile&operation=connection${query}`), post: (body: unknown) => fetch(`${base}/api/auth/capabilities/fallback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) };
}
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

describe('M30-03 authoritative capability route', () => {
  it('returns scoped authoritative normal with no-store', async () => { const h = await harness(); const response = await h.get(); expect(response.headers.get('cache-control')).toBe('no-store'); expect(await response.json()).toMatchObject({ mode: 'normal', authoritative: true, subject: { userId: 'u1', tenantId: 't1' } }); });
  it('distinguishes provider not configured', async () => { const h = await harness({ providerConfigured: () => false }); expect(await (await h.get()).json()).toMatchObject({ reasonCode: 'provider_not_configured' }); });
  it('distinguishes callback missing', async () => { const h = await harness({ callbackDomainConfigured: () => false }); expect(await (await h.get()).json()).toMatchObject({ reasonCode: 'callback_domain_missing' }); });
  it('distinguishes SSO unavailable', async () => { const h = await harness({ ssoAvailable: () => false }); const response = await fetch((await endpoint(h)) + '?provider=oidc&channel=web&operation=auth'); expect(await response.json()).toMatchObject({ reasonCode: 'sso_unavailable' }); });
  it('distinguishes token expired', async () => { const h = await harness({ credentialState: () => 'expired' }); expect(await (await h.get()).json()).toMatchObject({ reasonCode: 'credential_expired' }); });
  it('distinguishes tenant disabled', async () => { const h = await harness({ tenantAllowed: () => false }); expect(await (await h.get()).json()).toMatchObject({ reasonCode: 'tenant_policy_disabled' }); });
  it('distinguishes server degraded', async () => { const h = await harness({ serverDegraded: () => true }); expect(await (await h.get()).json()).toMatchObject({ reasonCode: 'server_degraded' }); });
  it('rejects account boundary mismatch', async () => { const h = await harness(); expect((await h.get('&userId=u2')).status).toBe(403); expect((await h.get('&tenantId=t2')).status).toBe(403); });
  it('accepts only an allowed fallback and audits without secrets', async () => { const h = await harness({ callbackDomainConfigured: () => false }); const response = await h.post({ provider: 'google-workspace', channel: 'mobile', operation: 'connection', action: 'use_system_browser_sso', correlationId: 'corr-12345678' }); expect(response.status).toBe(200); const log = await waitForAudit(join(h.dir, 'audit.jsonl'), 'capability_fallback_selected'); expect(log).toContain('capability_fallback_selected'); expect(log).not.toMatch(/access_token|refresh_token|client_secret/i); });
  it('rejects unsafe fallback choices', async () => { const h = await harness({ tenantAllowed: () => false }); expect((await h.post({ provider: 'google-workspace', channel: 'mobile', operation: 'connection', action: 'reauthenticate', correlationId: 'corr-12345678' })).status).toBe(409); });
  it('audits degraded entry and normal revalidation', async () => { const degraded = await harness({ serverDegraded: () => true }); await degraded.get(); const normal = await harness(); await normal.get(); expect(await waitForAudit(join(degraded.dir, 'audit.jsonl'), 'capability_degraded_entered')).toContain('capability_degraded_entered'); expect(await waitForAudit(join(normal.dir, 'audit.jsonl'), 'capability_normal_revalidated')).toContain('capability_normal_revalidated'); });
});

async function endpoint(h: Awaited<ReturnType<typeof harness>>): Promise<string> {
  const response = await h.get();
  return response.url.replace(/\/api\/auth\/capabilities\/status.*/, '/api/auth/capabilities/status');
}
