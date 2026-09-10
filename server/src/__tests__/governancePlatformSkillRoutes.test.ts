import type { Server } from 'node:http';
import express, { Router } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  registerGovernancePlatformSkillRoutes,
  type GovernanceResourcePersona,
} from '../routes/governancePlatformSkillRoutes.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function json(body: unknown): RequestInit {
  return {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function rig(input: {
  persona: GovernanceResourcePersona;
  update?: ReturnType<typeof vi.fn>;
  tenantExists?: (tenantId: string) => boolean;
}) {
  const update = input.update ?? vi.fn().mockResolvedValue(true);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user =
      input.persona === 'platform_admin'
        ? { sub: 'platform-1', username: 'root', tenantId: 'pantheon', role: 'admin' }
        : { sub: 'member-1', username: 'member', tenantId: 'tenant-a', role: 'user' };
    next();
  });
  const router = Router();
  registerGovernancePlatformSkillRoutes({
    router,
    personaFor: () => input.persona,
    updatePlatformSkillSettings: update as never,
    ...(input.tenantExists ? { tenantExists: input.tenantExists } : {}),
  });
  app.use('/api/governance/resources', router);
  const server: Server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  servers.push(server);
  const address = server.address();
  const base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  return { request: (path: string, init: RequestInit) => fetch(`${base}${path}`, init), update };
}

describe('平台技能治理资源路由', () => {
  it.each([
    ['all', ['tenant-a'], []],
    ['allow_tenants', ['tenant-a', 'tenant-a'], ['tenant-a']],
    ['deny_tenants', ['tenant-a'], ['tenant-a']],
  ] as const)('支持平台管理员设置开放范围 %s', async (exposure, tenantIds, expectedTenantIds) => {
    const test = await rig({
      persona: 'platform_admin',
      tenantExists: (tenantId) => tenantId === 'tenant-a',
    });
    const response = await test.request(
      '/api/governance/resources/skills/archive/platform-settings',
      json({
        enabled: true,
        exposure,
        tenantIds,
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      changed: true,
      skillId: 'archive',
      settings: { enabled: true, exposure, tenantIds: expectedTenantIds },
    });
    expect(test.update).toHaveBeenCalledWith({
      skillId: 'archive',
      settings: { enabled: true, exposure, tenantIds: expectedTenantIds },
    });
  });

  it('拒绝不存在的组织和技能', async () => {
    const update = vi.fn().mockResolvedValue(false);
    const test = await rig({
      persona: 'platform_admin',
      update,
      tenantExists: (tenantId) => tenantId === 'tenant-a',
    });
    const invalidTenant = await test.request(
      '/api/governance/resources/skills/archive/platform-settings',
      json({
        enabled: true,
        exposure: 'allow_tenants',
        tenantIds: ['missing'],
      }),
    );
    expect(invalidTenant.status).toBe(400);
    await expect(invalidTenant.json()).resolves.toMatchObject({
      code: 'SKILL_PLATFORM_TENANT_NOT_FOUND',
    });
    expect(update).not.toHaveBeenCalled();

    const missingSkill = await test.request(
      '/api/governance/resources/skills/missing/platform-settings',
      json({
        enabled: true,
        exposure: 'all',
        tenantIds: [],
      }),
    );
    expect(missingSkill.status).toBe(404);
    await expect(missingSkill.json()).resolves.toMatchObject({ code: 'PLATFORM_SKILL_NOT_FOUND' });
  });

  it('拒绝普通成员修改平台技能', async () => {
    const test = await rig({ persona: 'member' });
    const response = await test.request(
      '/api/governance/resources/skills/archive/platform-settings',
      json({
        enabled: true,
        exposure: 'all',
        tenantIds: [],
      }),
    );
    expect(response.status).toBe(403);
    expect(test.update).not.toHaveBeenCalled();
  });
});
