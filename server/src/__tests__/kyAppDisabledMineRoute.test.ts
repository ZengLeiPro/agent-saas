import { createServer, type Server } from 'node:http';

import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { registerKyAppRoutes, registerUnavailableMineRoute } from '../app/kyAppRoutes.js';
import type { AppRuntime } from '../app/runtime.js';

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
    expect(registerKyAppRoutes(app, {} as AppRuntime, { rawConfig })).toBeNull();
    registerUnavailableMineRoute(app);
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/systems/mine`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ installations: [] });
  });
});
