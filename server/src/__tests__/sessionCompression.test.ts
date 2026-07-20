import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { sessionCompression } from '../middleware/sessionCompression.js';

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('sessionCompression', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) await stopServer(server);
    server = null;
  });

  it('compresses large session JSON responses when the client accepts gzip', async () => {
    const app = express();
    app.use('/api/sessions', sessionCompression);
    app.get('/api/sessions/:sessionId', (_req, res) => {
      res.json({ content: '会话内容'.repeat(2_000) });
    });

    const baseUrl = await new Promise<string>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const address = server!.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        resolve(`http://127.0.0.1:${port}`);
      });
    });

    const response = await fetch(`${baseUrl}/api/sessions/example`, {
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-encoding')).toBe('gzip');
    await expect(response.json()).resolves.toEqual({ content: '会话内容'.repeat(2_000) });
  });
});
