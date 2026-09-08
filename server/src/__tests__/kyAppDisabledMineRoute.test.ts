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
  ])('represents %s as an empty installation list', async (_label, rawConfig) => {
    const app = express();
    app.use((req, _res, next) => {
      req.user = PLATFORM_ADMIN;
      next();
    });
    const assembly = registerKyAppRoutes(app, {} as AppRuntime, { rawConfig });
    expect(assembly).toBeNull();
    registerUnavailableMineRoute(app);
    registerKyAppAvailabilityRoute(app, assembly !== null);
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/systems/mine`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ installations: [] });
    const availability = await fetch(
      `http://127.0.0.1:${address.port}/api/app-contract/v1/availability`,
    );
    expect(availability.status).toBe(200);
    expect(availability.headers.get('cache-control')).toBe('no-store');
    await expect(availability.json()).resolves.toEqual({ enabled: false });
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
});
