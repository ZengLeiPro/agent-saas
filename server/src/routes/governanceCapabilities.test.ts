import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { createGovernanceCapabilitiesRouter } from './governanceCapabilities.js';

describe('governance capability inventory route', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve()));

  it('向前端公开 available/read_only/unavailable 受控清单', async () => {
    const app = express();
    app.use('/api/governance/capabilities', createGovernanceCapabilitiesRouter());
    server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const address = server!.address();
    const response = await fetch(
      `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/api/governance/capabilities`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { capabilities: Array<{ id: string; status: string }> };
    expect(body.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'organization.files', status: 'unavailable' }),
        expect.objectContaining({ id: 'platform.admins', status: 'read_only' }),
      ]),
    );
  });
});
