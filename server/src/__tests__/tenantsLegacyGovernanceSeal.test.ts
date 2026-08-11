import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TenantStore } from '../data/tenants/store.js';
import { createTenantsRouter } from '../routes/tenants.js';

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('legacy Tenant 高影响治理入口封闭', () => {
  it('即使迁移 gate 处于 shadow allow，settings/status/delete 也不能绕过签名治理 API', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tenant-governance-seal-'));
    roots.push(root);
    const tenantStore = new TenantStore(join(root, 'tenants.json'));
    await tenantStore.create({ id: 'tenant-a', name: 'Tenant A', createdBy: 'system' });
    const legacyGate = { assertLegacyWriteAllowed: vi.fn().mockResolvedValue(undefined) };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { sub: 'platform-1', username: 'platform', role: 'admin', tenantId: 'pantheon' };
      next();
    });
    app.use('/api/tenants', createTenantsRouter({
      tenantStore, sharedDir: join(root, 'shared'), legacyWriteGate: legacyGate,
    }));
    const server: Server = await new Promise(resolve => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    servers.push(server);
    const address = server.address();
    const base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
    const request = (path: string, method: string, body: unknown) => fetch(`${base}${path}`, {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

    for (const [path, method, body] of [
      ['/api/tenants/tenant-a/settings', 'PATCH', {}],
      ['/api/tenants/tenant-a/status', 'PATCH', { disabled: true }],
      ['/api/tenants/tenant-a', 'DELETE', { confirm: 'tenant-a' }],
    ] as const) {
      const response = await request(path, method, body);
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ code: 'MIGRATION_LEGACY_WRITE_SEALED' });
    }
    expect(legacyGate.assertLegacyWriteAllowed).not.toHaveBeenCalled();
    expect(tenantStore.findById('tenant-a')).toBeTruthy();
    expect(tenantStore.findById('tenant-a')?.disabled).not.toBe(true);
  });
});
