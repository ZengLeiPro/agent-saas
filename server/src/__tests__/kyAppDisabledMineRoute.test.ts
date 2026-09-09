import { createServer, type Server } from 'node:http';

import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import {
  registerKyAppRoutes,
  registerKyAppAvailabilityRoute,
  registerUnavailableMineRoute,
} from '../app/kyAppRoutes.js';
import type { AppRuntime } from '../app/runtime.js';
import { PLATFORM_ADMIN, ORG_ADMIN, MEMBER } from '../kyapp/__tests__/harness.js';

let server: Server | null = null;

afterEach(async () => {
  const current = server;
  server = null;
  if (current) await new Promise<void>((resolve) => current.close(() => resolve()));
});

describe('disabled kyApp shell contract', () => {
  it.each([
    ['not configured', null],
    ['invalid config', { kyApp: { environment: 'invalid' } }],
    ['runtime dependencies missing', { kyApp: { environment: 'prod' } }],
  ])('represents %s without falling through to the SPA', async (_label, rawConfig) => {
    const app = express();
    app.use((req, _res, next) => {
      req.user = PLATFORM_ADMIN;
      next();
    });
    const assembly = registerKyAppRoutes(app, {} as AppRuntime, { rawConfig });
    expect(assembly).toBeNull();
    registerUnavailableMineRoute(app);
    registerKyAppAvailabilityRoute(app, assembly !== null);
    app.use((_req, res) => {
      res.type('html').send('<html>SPA fallback</html>');
    });
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const base = `http://127.0.0.1:${address.port}`;

    const response = await fetch(`${base}/api/systems/mine`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ installations: [] });
    const availability = await fetch(`${base}/api/app-contract/v1/availability`);
    expect(availability.status).toBe(200);
    expect(availability.headers.get('cache-control')).toBe('no-store');
    await expect(availability.json()).resolves.toEqual({ enabled: false });

    for (const path of ['/usage?tenantId=tenant-a', '/installations/iid-1/usage']) {
      const usage = await fetch(`${base}/api/app-contract/v1${path}`, {
        headers: { 'x-ky-request-id': 'usage-regression' },
      });
      expect(usage.status).toBe(503);
      expect(usage.headers.get('content-type')).toContain('application/json');
      expect(usage.headers.get('cache-control')).toBe('no-store');
      await expect(usage.json()).resolves.toEqual({
        ok: false,
        error: {
          code: 'unavailable',
          retryable: true,
          requestId: 'usage-regression',
          message: '业务系统接入功能尚未启用或服务依赖未就绪，请联系平台管理员。',
        },
      });
    }
  });

  it.each([PLATFORM_ADMIN, ORG_ADMIN, MEMBER, undefined])(
    'restricts availability to platform admins ($username)',
    async (user) => {
      const app = express();
      app.use((req, _res, next) => {
        req.user = user;
        next();
      });
      registerKyAppAvailabilityRoute(app, true);
      server = createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind');
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/app-contract/v1/availability`,
      );
      expect(response.status).toBe(user === PLATFORM_ADMIN ? 200 : 403);
      if (user === PLATFORM_ADMIN)
        await expect(response.json()).resolves.toEqual({ enabled: true });
    },
  );

  it.each([ORG_ADMIN, undefined])(
    'returns a disabled usage error without requiring the platform probe ($username)',
    async (user) => {
      const app = express();
      app.use((req, _res, next) => {
        req.user = user;
        next();
      });
      registerKyAppAvailabilityRoute(app, false);
      server = createServer(app);
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind');
      const base = `http://127.0.0.1:${address.port}/api/app-contract/v1`;
      const usage = await fetch(`${base}/usage?tenantId=tenant-a`);
      expect(usage.status).toBe(user ? 503 : 401);
      const body = await usage.json();
      expect(body.error.code).toBe(user ? 'unavailable' : 'unauthorized');
      expect(body.overview).toBeUndefined();
      const availability = await fetch(`${base}/availability`);
      expect(availability.status).toBe(403);
    },
  );

  it('does not intercept usage routes when the subsystem is enabled', async () => {
    const app = express();
    registerKyAppAvailabilityRoute(app, true);
    app.get('/api/app-contract/v1/usage', (_req, res) => {
      res.json({ overview: { tenantId: 'tenant-a' } });
    });
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/app-contract/v1/usage?tenantId=tenant-a`,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ overview: { tenantId: 'tenant-a' } });
  });
});
