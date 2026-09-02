import express from 'express';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthEpochAuthority } from '../auth/authEpochAuthority.js';
import type { JwtPayload } from '../auth/types.js';
import {
  LEGACY_PREVIEW_CSP,
  LEGACY_PREVIEW_MAX_TTL_MS,
  createPreviewRoutes,
} from '../routes/preview.js';

type UserRecord = { id: string; username: string; tenantId: string; disabled?: boolean };

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'legacy-preview-malicious.html');

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function startServer(input: {
  agentCwd: string;
  user: () => JwtPayload | undefined;
  now: () => number;
  authority: AuthEpochAuthority;
  users: Map<string, UserRecord>;
}) {
  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    req.user = input.user();
    next();
  });
  const routes = createPreviewRoutes({
    agentCwd: input.agentCwd,
    now: input.now,
    authEpochAuthority: input.authority,
    userStore: { findById: (id: string) => input.users.get(id) as never },
  });
  app.use('/api', routes.tokenRouter);
  app.use('/preview', routes.serveRouter);
  return new Promise<{ server: Server; baseUrl: string }>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

describe('M50-03 retired legacy HTML preview', () => {
  let agentCwd = '';
  let workspace = '';
  let now = Date.UTC(2026, 8, 1, 0, 0, 0);
  let authority: AuthEpochAuthority;
  let user: JwtPayload;
  let users: Map<string, UserRecord>;
  const servers: Server[] = [];

  beforeEach(async () => {
    agentCwd = await mkdtemp(join(tmpdir(), 'legacy-preview-'));
    workspace = join(agentCwd, 'kaiyan', 'user-1');
    await mkdir(join(workspace, 'reports'), { recursive: true });
    await copyFile(FIXTURE, join(workspace, 'reports', 'attack.html'));
    await writeFile(join(workspace, 'MEMORY.md'), 'SIBLING_SECRET', 'utf8');
    authority = new AuthEpochAuthority();
    const binding = authority.issueLogin('user-1');
    user = { sub: 'user-1', username: 'alice', role: 'user', tenantId: 'kaiyan', ...binding };
    users = new Map([['user-1', { id: 'user-1', username: 'alice', tenantId: 'kaiyan' }]]);
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(stopServer));
    await rm(agentCwd, { recursive: true, force: true });
  });

  async function rig() {
    const running = await startServer({
      agentCwd,
      user: () => user,
      now: () => now,
      authority,
      users,
    });
    servers.push(running.server);
    return running;
  }

  async function issue(baseUrl: string, body: Record<string, unknown> = {}) {
    return fetch(`${baseUrl}/api/file/preview-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'reports/attack.html', surface: 'web-n-1', ...body }),
    });
  }

  it('scopes a <=5 minute latest-wins grant to one canonical file and serves only a static retirement page', async () => {
    const { baseUrl } = await rig();
    const issued = await issue(baseUrl);
    expect(issued.status).toBe(200);
    const grant = await issued.json() as {
      token: string; nonce: string; version: number; ttlSeconds: number;
      target: { kind: string; path: string };
    };
    expect(grant).toMatchObject({
      version: 1,
      target: { kind: 'file', path: 'reports/attack.html' },
    });
    expect(grant.nonce).toMatch(/^[0-9a-f-]{36}$/);
    expect(grant.ttlSeconds).toBeGreaterThan(0);
    expect(grant.ttlSeconds * 1000).toBeLessThanOrEqual(LEGACY_PREVIEW_MAX_TTL_MS);

    const served = await fetch(`${baseUrl}/preview/${grant.token}/reports/attack.html`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-security-policy')).toBe(LEGACY_PREVIEW_CSP);
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(served.headers.get('referrer-policy')).toBe('no-referrer');
    expect(served.headers.get('cache-control')).toContain('no-store');
    const html = await served.text();
    expect(html).toContain('旧 HTML 预览已停用');
    expect(html).toContain('Artifact viewer');
    expect(html).not.toContain('SIBLING_SECRET');
    expect(html).not.toContain('egress.invalid');

    const { document } = parseHTML(html);
    const activeOrEgress = document.querySelectorAll([
      'script', 'img', 'form', 'iframe', 'object', 'embed', 'link',
      'meta[http-equiv]', 'base', '[src]', '[href]', '[action]',
    ].join(','));
    expect(activeOrEgress.length).toBe(0); // no JS execution and zero egress request candidates

    expect((await fetch(`${baseUrl}/preview/${grant.token}/MEMORY.md`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/preview/${grant.token}/reports/MEMORY.md`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/preview/${grant.token}/reports/%252fMEMORY.md`)).status).toBe(403);

    const refreshed = await issue(baseUrl);
    const replacement = await refreshed.json() as { token: string };
    expect(replacement.token).not.toBe(grant.token);
    expect((await fetch(`${baseUrl}/preview/${grant.token}/reports/attack.html`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/preview/${replacement.token}`)).status).toBe(200);
  });

  it('expires, explicitly revokes, fences on auth lifecycle change, and loses all grants on restart', async () => {
    const first = await rig();
    const grant1 = await (await issue(first.baseUrl)).json() as { token: string; ttlSeconds: number };
    now += grant1.ttlSeconds * 1000 + 1;
    expect((await fetch(`${first.baseUrl}/preview/${grant1.token}`)).status).toBe(401);

    now = Date.UTC(2026, 8, 1, 0, 0, 0);
    const grant2 = await (await issue(first.baseUrl)).json() as { token: string };
    const revoked = await fetch(`${first.baseUrl}/api/file/preview-token`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: grant2.token }),
    });
    expect(revoked.status).toBe(204);
    expect((await fetch(`${first.baseUrl}/preview/${grant2.token}`)).status).toBe(401);

    const grant3 = await (await issue(first.baseUrl)).json() as { token: string };
    authority.fence('user-1', 'revoke');
    expect((await fetch(`${first.baseUrl}/preview/${grant3.token}`)).status).toBe(401);

    const rebound = authority.issueLogin('user-1');
    user = { ...user, ...rebound };
    const grant4 = await (await issue(first.baseUrl)).json() as { token: string };
    const restarted = await rig();
    expect((await fetch(`${restarted.baseUrl}/preview/${grant4.token}`)).status).toBe(401);
  });

  it('rejects mobile-v1, cross-tenant/owner switching, noncanonical paths, siblings, symlinks, and unsupported versions', async () => {
    const { baseUrl } = await rig();
    for (const marker of [
      { surface: 'mobile-v1' },
      { capability: 'mobile-v1', surface: undefined },
    ]) {
      const response = await issue(baseUrl, marker);
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ code: 'MOBILE_V1_PREVIEW_DISABLED' });
    }
    const headerDenied = await fetch(`${baseUrl}/api/file/preview-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-surface': 'mobile-v1' },
      body: JSON.stringify({ path: 'reports/attack.html' }),
    });
    expect(headerDenied.status).toBe(403);

    expect((await issue(baseUrl, { owner: 'bob' })).status).toBe(403);
    expect((await issue(baseUrl, { version: 2 })).status).toBe(400);
    for (const path of [
      '../MEMORY.md', 'reports/../MEMORY.md', '/etc/passwd',
      'reports\\attack.html', 'reports/%2fattack.html', 'reports/%2e%2e/MEMORY.md',
      'reports/attack.html/other.html', 'reports/attack.js',
    ]) {
      expect((await issue(baseUrl, { path })).status, path).toBeGreaterThanOrEqual(400);
    }

    await symlink('../MEMORY.md', join(workspace, 'reports', 'linked.html'));
    expect((await issue(baseUrl, { path: 'reports/linked.html' })).status).toBe(403);

    const aliceGrant = await (await issue(baseUrl)).json() as { token: string };
    user = { sub: 'user-2', username: 'bob', role: 'user', tenantId: 'other', ...authority.issueLogin('user-2') };
    users.set('user-2', { id: 'user-2', username: 'bob', tenantId: 'other' });
    const crossTenantRevoke = await fetch(`${baseUrl}/api/file/preview-token`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: aliceGrant.token }),
    });
    expect(crossTenantRevoke.status).toBe(404);
    expect((await issue(baseUrl)).status).toBe(404); // Bob cannot resolve Alice's canonical workspace file.

    users.set('user-1', { id: 'user-1', username: 'alice', tenantId: 'moved' });
    expect((await fetch(`${baseUrl}/preview/${aliceGrant.token}`)).status).toBe(401);
  });
});
