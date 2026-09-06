/**
 * 壳侧安全事件上报：闭集与服务端一致、有界、永不抛错。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const authFetch = vi.fn(async () => new Response(null, { status: 204 }));
vi.mock('@/lib/authFetch', () => ({
  authFetch: (...args: unknown[]) => authFetch(...(args as [])),
}));

const { APP_SHELL_EVENTS, reportAppShellEvent } = await import('./appShellAudit');

afterEach(() => {
  authFetch.mockClear();
  authFetch.mockImplementation(async () => new Response(null, { status: 204 }));
});

function lastBody(): Record<string, unknown> {
  const call = authFetch.mock.calls.at(-1) as unknown as [string, RequestInit];
  return JSON.parse(String(call[1].body)) as Record<string, unknown>;
}

describe('reportAppShellEvent', () => {
  it('POST 到壳事件端点，走 authFetch（不裸 fetch）', async () => {
    await reportAppShellEvent({
      event: 'path_rejected',
      installationId: 'inst-1',
      reason: 'scheme',
    });
    const call = authFetch.mock.calls.at(-1) as unknown as [string, RequestInit];
    expect(call[0]).toBe('/api/app-contract/v1/shell-events');
    expect(call[1].method).toBe('POST');
    expect(lastBody()).toEqual({
      event: 'path_rejected',
      installationId: 'inst-1',
      reason: 'scheme',
    });
  });

  it('事件闭集与服务端同名', () => {
    expect([...APP_SHELL_EVENTS]).toEqual([
      'handshake_failed',
      'attestation_failed',
      'path_rejected',
      'link_blocked',
      'message_rejected',
      'agent_open',
    ]);
  });

  it('reason / detail 在客户端就截断，不白跑一趟 400', async () => {
    await reportAppShellEvent({
      event: 'message_rejected',
      installationId: 'inst-1',
      reason: 'r'.repeat(200),
      detail: 'd'.repeat(500),
    });
    const body = lastBody();
    expect(String(body.reason)).toHaveLength(64);
    expect(String(body.detail)).toHaveLength(200);
  });

  it('缺 installationId 直接不发（服务端会 400，没意义）', async () => {
    await reportAppShellEvent({ event: 'agent_open', installationId: '' });
    expect(authFetch).not.toHaveBeenCalled();
  });

  it('审计不可达时静默吞掉，绝不把界面卡住', async () => {
    authFetch.mockImplementation(async () => {
      throw new Error('network down');
    });
    await expect(
      reportAppShellEvent({ event: 'handshake_failed', installationId: 'inst-1' }),
    ).resolves.toBeUndefined();
  });
});
