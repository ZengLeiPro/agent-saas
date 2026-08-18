import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_TENANT_SETTINGS } from '../data/tenants/types.js';
import { registerGovernanceTenantSettingsRoutes } from '../routes/governanceTenantSettingsRoutes.js';
import type { TenantSettingsPatch } from '../routes/tenantSettingsValidation.js';

const NOW = '2026-08-10T09:00:00.000Z';
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function rig(options: {
  platformAdmin?: boolean;
  updatedAt?: string;
} = {}) {
  let settings = structuredClone(DEFAULT_TENANT_SETTINGS);
  let updatedAt = options.updatedAt ?? NOW;
  const updateTenantSettings = vi.fn(async (
    _tenantId: string,
    nextSettings: TenantSettingsPatch,
  ) => {
    settings = structuredClone(nextSettings) as typeof settings;
    updatedAt = '2026-08-10T09:03:00.000Z';
    return { settings, updatedAt };
  });
  const router = express.Router();
  registerGovernanceTenantSettingsRoutes(router, {
    personaFor: () => options.platformAdmin ? 'platform_admin' : 'org_admin',
    tenantFor: (_req, requested) => {
      if (options.platformAdmin) return requested ?? 'pantheon';
      return !requested || requested === 'tenant-a' ? 'tenant-a' : null;
    },
    getTenantSettings: tenantId => tenantId === 'tenant-a' ? { settings, updatedAt } : undefined,
    updateTenantSettings,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/governance/access', router);
  const server: Server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  servers.push(server);
  const address = server.address();
  const base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  return {
    request: (path: string, init?: RequestInit) => fetch(`${base}${path}`, init),
    updateTenantSettings,
  };
}

describe('governed tenant settings routes', () => {
  it('组织管理员读取并按版本更新本组织设置', async () => {
    const test = await rig();
    const read = await test.request('/api/governance/access/tenant-settings');
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({
      tenantId: 'tenant-a', updatedAt: NOW, settings: { features: { filesEnabled: true } },
    });

    const settings = structuredClone(DEFAULT_TENANT_SETTINGS);
    settings.features.filesEnabled = false;
    const update = await test.request('/api/governance/access/tenant-settings', json('PUT', {
      settings,
      expectedUpdatedAt: NOW,
    }));
    expect(update.status).toBe(200);
    await expect(update.json()).resolves.toMatchObject({
      tenantId: 'tenant-a',
      updatedAt: '2026-08-10T09:03:00.000Z',
      settings: { features: { filesEnabled: false } },
    });
    expect(test.updateTenantSettings).toHaveBeenCalledWith('tenant-a', expect.objectContaining({
      features: expect.objectContaining({ filesEnabled: false }),
    }), NOW);
  });

  it('平台管理员可授权目标组织使用调试模式', async () => {
    const test = await rig({ platformAdmin: true });
    const settings = structuredClone(DEFAULT_TENANT_SETTINGS);
    settings.features.debugModeAllowed = true;
    const response = await test.request('/api/governance/access/tenant-settings?tenantId=tenant-a', json('PUT', {
      settings,
      expectedUpdatedAt: NOW,
    }));
    expect(response.status).toBe(200);
    expect(test.updateTenantSettings).toHaveBeenCalledWith('tenant-a', expect.objectContaining({
      features: expect.objectContaining({ debugModeAllowed: true, debugModeEnabled: false }),
    }), NOW);
  });

  it('组织管理员不能越权开启平台调试模式授权', async () => {
    const test = await rig();
    const settings = structuredClone(DEFAULT_TENANT_SETTINGS);
    settings.features.debugModeAllowed = true;
    const response = await test.request('/api/governance/access/tenant-settings', json('PUT', {
      settings,
      expectedUpdatedAt: NOW,
    }));
    expect(response.status).toBe(403);
    expect(test.updateTenantSettings).not.toHaveBeenCalled();
  });

  it('拒绝组织管理员修改平台专属配额', async () => {
    const test = await rig();
    const settings = structuredClone(DEFAULT_TENANT_SETTINGS);
    settings.quotas.maxUsers = 100;
    const response = await test.request('/api/governance/access/tenant-settings', json('PUT', {
      settings,
      expectedUpdatedAt: NOW,
    }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: '组织配额仅平台管理员可配置' });
    expect(test.updateTenantSettings).not.toHaveBeenCalled();
  });

  it('设置版本漂移时返回 CAS 冲突且不写入', async () => {
    const test = await rig({ updatedAt: '2026-08-10T09:04:00.000Z' });
    const response = await test.request('/api/governance/access/tenant-settings', json('PUT', {
      settings: DEFAULT_TENANT_SETTINGS,
      expectedUpdatedAt: NOW,
    }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'TENANT_SETTINGS_BASELINE_CONFLICT' });
    expect(test.updateTenantSettings).not.toHaveBeenCalled();
  });
});
