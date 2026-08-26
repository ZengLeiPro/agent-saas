import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcsOrchestratorConfig } from './config.js';
import { AlertDispatcher } from './alerts.js';

afterEach(() => vi.unstubAllGlobals());

describe('AlertDispatcher', () => {
  it('falls back across configured webhook URLs without exposing authorization in logs', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const logs: string[] = [];
    const dispatcher = new AlertDispatcher(
      {
        namespace: 'agent-saas-staging',
        alertWebhookUrls: ['https://first.test/alert', 'https://second.test/alert'],
        alertWebhookBearerToken: 'not-for-logs',
        alertMinIntervalMs: 0,
      } as AcsOrchestratorConfig,
      {
        info: (message) => logs.push(message),
        warn: (message) => logs.push(message),
        error: (message) => logs.push(message),
      },
    );

    await dispatcher.emit({ event: 'test', severity: 'warning', message: 'fallback' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logs.join('\n')).not.toContain('not-for-logs');
  });
});
