import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGovernanceResourcesRouter } from '../routes/governanceResources.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe('governance skill version route', () => {
  it('按显式参数返回技能当前版本，供交付工具校验内容漂移', async () => {
    const resource = {
      skillId: 'tenant-s',
      tenantId: 'tenant-a',
      scope: 'tenant',
      status: 'published',
      currentVersionId: 'skillv-1',
      revision: 1,
    };
    const version = {
      versionId: 'skillv-1',
      skillId: 'tenant-s',
      definition: { contentDigest: 'digest-1' },
    };
    const app = express();
    app.use((req, _res, next) => {
      req.user = {
        sub: 'platform-1',
        username: 'root',
        tenantId: 'pantheon',
        role: 'admin',
      };
      next();
    });
    app.use(
      '/api/governance/resources',
      createGovernanceResourcesRouter({
        offboardingPreviewSecret: 'test-offboarding-preview-secret-32-characters',
        memberships: {
          getPlatformAdmin: vi.fn().mockResolvedValue({
            userId: 'platform-1',
            status: 'active',
          }),
        },
        skills: {
          getResource: vi.fn().mockResolvedValue(resource),
          getVersion: vi.fn().mockResolvedValue(version),
        },
        changeJobs: {},
        audit: {},
        vault: {},
      } as never),
    );
    const server: Server = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    servers.push(server);
    const address = server.address();
    const base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';

    const response = await fetch(
      `${base}/api/governance/resources/skills/tenant-s?tenantId=tenant-a&includeVersion=true`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ resource, version });
  });
});
