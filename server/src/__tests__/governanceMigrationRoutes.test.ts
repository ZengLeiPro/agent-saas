import type { Server } from 'node:http';

import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JwtPayload } from '../auth/types.js';
import { createGovernanceMigrationRouter } from '../routes/governanceMigration.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function requestAs(user: JwtPayload): Promise<Response> {
  const app = express();
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use(
    '/api/governance/migration',
    createGovernanceMigrationRouter({
      memberships: {
        getPlatformAdmin: vi.fn().mockResolvedValue({ status: 'active' }),
      } as never,
      store: {
        getControl: vi.fn().mockResolvedValue({ mode: 'shadow' }),
        listDomains: vi.fn().mockResolvedValue([]),
        listDifferences: vi.fn().mockResolvedValue([]),
      } as never,
      audit: { append: vi.fn() } as never,
    }),
  );
  const server: Server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  servers.push(server);
  const address = server.address();
  const base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  return await fetch(`${base}/api/governance/migration`);
}

describe('governance migration platform identity', () => {
  it('active platform_admin 事实只对 pantheon 身份生效', async () => {
    const stale = await requestAs({
      sub: 'admin-1',
      username: 'admin',
      tenantId: 'tenant-a',
      role: 'admin',
    });
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({ code: 'PLATFORM_ADMIN_REQUIRED' });

    const platform = await requestAs({
      sub: 'platform-1',
      username: 'root',
      tenantId: 'pantheon',
      role: 'admin',
    });
    expect(platform.status).toBe(200);
  });
});
