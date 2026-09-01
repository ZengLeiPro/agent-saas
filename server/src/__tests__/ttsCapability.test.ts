import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../integrations/tts/ttsClient.js', () => ({
  synthesize: vi.fn(async () => Buffer.from([1, 2, 3, 4])),
  estimateDuration: vi.fn(() => 250),
}));

import { synthesize } from '../integrations/tts/ttsClient.js';
import { isTtsCapabilityEnabled } from '../integrations/tts/capability.js';
import { createTtsRouter, type TtsRouterConfig } from '../routes/tts.js';

async function start(config: TtsRouterConfig): Promise<{ baseUrl: string; server: Server }> {
  const app = express();
  app.use(express.json());
  app.use('/api', createTtsRouter(config));
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

describe('M50-04 TTS fail-closed capability', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  });

  it('defaults off and makes no provider call for absent, credential-only, or incomplete config', async () => {
    expect(isTtsCapabilityEnabled(undefined)).toBe(false);
    expect(isTtsCapabilityEnabled({ doubaoAppId: 'app', doubaoApiKey: 'key' })).toBe(false);
    expect(isTtsCapabilityEnabled({ enabled: true, doubaoAppId: '', doubaoApiKey: 'key' })).toBe(false);
    for (const tts of [undefined, { doubaoAppId: 'app', doubaoApiKey: 'key' }] as const) {
      const rig = await start({ tts });
      servers.push(rig.server);
      const response = await fetch(`${rig.baseUrl}/api/tts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '不得合成' }),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'TTS_DISABLED' });
    }
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('synthesizes only after explicit enablement and emits safe audio headers', async () => {
    const rig = await start({ tts: { enabled: true, doubaoAppId: 'app', doubaoApiKey: 'key' } });
    servers.push(rig.server);
    const response = await fetch(`${rig.baseUrl}/api/tts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '已明确开启' }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('audio/mpeg');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(synthesize).toHaveBeenCalledOnce();
  });
});
