import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createVoiceRouter, type VoiceRouterOptions } from '../routes/voice.js';

const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const ATTACHMENT_ID = '22222222-2222-4222-8222-222222222222';
const BODY = { requestId: REQUEST_ID, attachmentId: ATTACHMENT_ID, durationMs: 1_500 };
const RESULT = {
  ...BODY,
  transcriptionId: '33333333-3333-4333-8333-333333333333',
  status: 'ready' as const,
  text: '刷新后转写',
  source: 'server_stt' as const,
};

async function startVoiceServer(options: Pick<VoiceRouterOptions, 'refreshSharedConfig' | 'transcriptionService'>): Promise<{
  baseUrl: string;
  server: Server;
}> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { sub: 'user-1', username: 'alice', role: 'user', tenantId: 'tenant-a' };
    next();
  });
  app.use('/api', createVoiceRouter({ agentCwd: '/agent', ...options }));
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test server address');
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

async function post(baseUrl: string): Promise<Response> {
  return fetch(`${baseUrl}/api/voice/transcriptions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(BODY),
  });
}

describe('Voice route shared config refresh gate', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  });

  it('awaits a successful forced refresh before invoking the transcription service', async () => {
    let resolveRefresh: ((value: boolean) => void) | undefined;
    const refreshSharedConfig = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveRefresh = resolve;
    }));
    const request = vi.fn(async () => RESULT);
    const rig = await startVoiceServer({
      refreshSharedConfig,
      transcriptionService: { request } as unknown as VoiceRouterOptions['transcriptionService'],
    });
    servers.push(rig.server);

    const pendingResponse = post(rig.baseUrl);
    await vi.waitFor(() => expect(refreshSharedConfig).toHaveBeenCalledWith(true));
    expect(request).not.toHaveBeenCalled();

    resolveRefresh?.(true);
    const response = await pendingResponse;

    expect(response.status).toBe(201);
    expect(request).toHaveBeenCalledOnce();
    expect(refreshSharedConfig.mock.invocationCallOrder[0]).toBeLessThan(request.mock.invocationCallOrder[0]);
  });

  it('returns a stable 503 and does not call the service when refresh returns false', async () => {
    const refreshSharedConfig = vi.fn(async () => false);
    const request = vi.fn();
    const rig = await startVoiceServer({
      refreshSharedConfig,
      transcriptionService: { request } as unknown as VoiceRouterOptions['transcriptionService'],
    });
    servers.push(rig.server);

    const response = await post(rig.baseUrl);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      success: false,
      error: {
        code: 'STT_CONFIG_REFRESH_FAILED',
        message: '语音识别配置暂不可用',
        retryable: true,
      },
    });
    expect(refreshSharedConfig).toHaveBeenCalledWith(true);
    expect(request).not.toHaveBeenCalled();
  });

  it('returns the same redacted 503 and does not call the service when refresh throws', async () => {
    const refreshSharedConfig = vi.fn(async () => {
      throw new Error('secret=old-provider-key internal refresh path');
    });
    const request = vi.fn();
    const rig = await startVoiceServer({
      refreshSharedConfig,
      transcriptionService: { request } as unknown as VoiceRouterOptions['transcriptionService'],
    });
    servers.push(rig.server);

    const response = await post(rig.baseUrl);
    const responseText = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(responseText)).toEqual({
      success: false,
      error: {
        code: 'STT_CONFIG_REFRESH_FAILED',
        message: '语音识别配置暂不可用',
        retryable: true,
      },
    });
    expect(responseText).not.toMatch(/old-provider-key|internal refresh path/);
    expect(refreshSharedConfig).toHaveBeenCalledWith(true);
    expect(request).not.toHaveBeenCalled();
  });
});
