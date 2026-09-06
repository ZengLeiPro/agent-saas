import { beforeEach, describe, expect, it, vi } from 'vitest';

async function loadConfigModule() {
  vi.resetModules();
  return import('./webConfig');
}

async function loadResolver() {
  vi.resetModules();
  return (await import('./webConfig')).resolveApiBase;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('web auth-enabled startup state', () => {
  it('fails safe before AuthContext publishes the authoritative result', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { webConfig } = await loadConfigModule();

    expect(await webConfig.isAuthEnabled!()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('revalidates no-auth through public health without probing /api/auth/me', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ authEnabled: false }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ authEnabled: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { setWebAuthEnabled, webConfig } = await loadConfigModule();

    setWebAuthEnabled(false);
    expect(await webConfig.isAuthEnabled!()).toBe(false);
    expect(await webConfig.isAuthEnabled!()).toBe(true);
    expect(await webConfig.isAuthEnabled!()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => String(url).endsWith('/api/health'))).toBe(true);
  });

  it('keeps a no-auth result when an older health response has no capability field', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { setWebAuthEnabled, webConfig } = await loadConfigModule();

    setWebAuthEnabled(false);
    expect(await webConfig.isAuthEnabled!()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/api\/health$/);
  });

  it('singleflights concurrent no-auth revalidation', async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(
      () => new Promise<Response>((resolve) => { resolveFetch = resolve; }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { setWebAuthEnabled, webConfig } = await loadConfigModule();
    setWebAuthEnabled(false);

    const first = webConfig.isAuthEnabled!();
    const second = webConfig.isAuthEnabled!();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFetch(new Response(JSON.stringify({ authEnabled: false }), { status: 200 }));
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
  });
});

describe('immutable Web artifact API routing', () => {
  it('routes the exact Staging hostname to the isolated API', async () => {
    const resolveApiBase = await loadResolver();
    expect(resolveApiBase('https://api.agent.kaiyan.net', 'staging-agent.kaiyan.net')).toBe(
      'https://staging-agent-api.kaiyan.net',
    );
  });

  it('keeps production and lookalike hostnames on the compiled production API', async () => {
    const resolveApiBase = await loadResolver();
    expect(resolveApiBase('https://api.agent.kaiyan.net/', 'agent.kaiyan.net')).toBe(
      'https://api.agent.kaiyan.net',
    );
    expect(
      resolveApiBase('https://api.agent.kaiyan.net', 'staging-agent.kaiyan.net.evil.test'),
    ).toBe('https://api.agent.kaiyan.net');
  });

  it('preserves same-origin local development when no compiled API exists', async () => {
    const resolveApiBase = await loadResolver();
    expect(resolveApiBase(undefined, 'localhost')).toBe('');
  });
});
