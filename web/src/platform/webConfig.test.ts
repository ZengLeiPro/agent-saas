import { beforeEach, describe, expect, it, vi } from 'vitest';

async function loadConfig() {
  vi.resetModules();
  return (await import('./webConfig')).webConfig;
}

async function loadResolver() {
  vi.resetModules();
  return (await import('./webConfig')).resolveApiBase;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('web auth-enabled probe caching', () => {
  it('singleflights concurrent probes and caches true', async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const config = await loadConfig();

    const first = config.isAuthEnabled!();
    const second = config.isAuthEnabled!();
    expect(first).toBe(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(new Response(null, { status: 200 }));
    await expect(first).resolves.toBe(true);
    await expect(config.isAuthEnabled!()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not cache a 404 false result', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const config = await loadConfig();

    await expect(config.isAuthEnabled!()).resolves.toBe(false);
    await expect(config.isAuthEnabled!()).resolves.toBe(true);
    await expect(config.isAuthEnabled!()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails safe on network errors without caching the fallback', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const config = await loadConfig();

    await expect(config.isAuthEnabled!()).resolves.toBe(true);
    await expect(config.isAuthEnabled!()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
