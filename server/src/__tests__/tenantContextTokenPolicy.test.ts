import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JwtPayload } from '../auth/types.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { TenantStore } from '../data/tenants/store.js';
import { createTenantsRouter } from '../routes/tenants.js';

const PLATFORM_ADMIN: JwtPayload = {
  sub: 'platform-admin',
  username: 'platform-admin',
  role: 'admin',
  tenantId: DEFAULT_TENANT_ID,
};
const TENANT_ADMIN: JwtPayload = {
  sub: 'tenant-admin',
  username: 'tenant-admin',
  role: 'admin',
  tenantId: 'wain',
};

describe('tenant context token detail policy', () => {
  let tmpRoot: string;
  let server: Server;
  let baseUrl: string;
  let caller: JwtPayload;
  let tenantStore: TenantStore;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'tenant-context-token-policy-'));
    tenantStore = new TenantStore(join(tmpRoot, 'tenants.json'));
    await tenantStore.create({ id: 'wain', name: '唯恩电气', createdBy: 'system' });
    caller = PLATFORM_ADMIN;

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = caller;
      next();
    });
    app.use('/api/tenants', createTenantsRouter({ tenantStore, sharedDir: tmpRoot }));

    server = await new Promise(resolve => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    const address = server.address();
    baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('allows only platform admins to change detail expansion', async () => {
    const settings = tenantStore.getSettings('wain')!;
    settings.models.allowContextTokenDetails = true;

    const enabled = await fetch(`${baseUrl}/api/tenants/wain/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings }),
    });
    expect(enabled.status).toBe(200);
    expect(tenantStore.getSettings('wain')?.models.allowContextTokenDetails).toBe(true);

    caller = TENANT_ADMIN;
    const tenantSettings = tenantStore.getSettings('wain')!;
    tenantSettings.models.allowContextTokenDetails = false;
    const rejected = await fetch(`${baseUrl}/api/tenants/wain/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: tenantSettings }),
    });

    expect(rejected.status).toBe(403);
    await expect(rejected.json()).resolves.toEqual({ error: '上下文 Token 明细仅平台管理员可配置' });
    expect(tenantStore.getSettings('wain')?.models.allowContextTokenDetails).toBe(true);
  });
});
