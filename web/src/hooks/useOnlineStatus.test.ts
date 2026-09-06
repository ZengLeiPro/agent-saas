import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CANONICAL_REACHABILITY_EVENT } from '@/lib/lifecycleAdapter';
import { initialOnlineStatus, useOnlineStatus } from './useOnlineStatus';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 200 })),
  );
});

afterEach(() => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  vi.unstubAllGlobals();
});

describe('useOnlineStatus', () => {
  it('keeps an online browser hint unknown until the initial reachability probe succeeds', async () => {
    let resolveProbe!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    const { result } = renderHook(() => useOnlineStatus());

    expect(result.current).toBeNull();
    await act(async () => {
      resolveProbe(new Response(null, { status: 200 }));
      await Promise.resolve();
    });
    expect(result.current).toBe(true);
  });

  it('reports a browser-confirmed offline startup immediately', () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    const { result } = renderHook(() => useOnlineStatus());

    expect(result.current).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('settles unknown to offline when the initial probe cannot reach the API', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('network unavailable'));
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    const { result } = renderHook(() => useOnlineStatus());

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBe(false);
  });

  it('singleflights concurrent initial probes', async () => {
    let resolveProbe!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const first = renderHook(() => useOnlineStatus());
    const second = renderHook(() => useOnlineStatus());

    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveProbe(new Response(null, { status: 200 }));
      await Promise.resolve();
    });
    expect(first.result.current).toBe(true);
    expect(second.result.current).toBe(true);
  });

  it('does not let a stale initial success override a newer offline event', async () => {
    let resolveProbe!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const { result } = renderHook(() => useOnlineStatus());

    act(() => window.dispatchEvent(new Event('offline')));
    await act(async () => {
      resolveProbe(new Response(null, { status: 200 }));
      await Promise.resolve();
    });
    expect(result.current).toBe(false);
  });

  it('continues to consume canonical lifecycle updates after startup', async () => {
    const { result } = renderHook(() => useOnlineStatus());
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      window.dispatchEvent(
        new CustomEvent<boolean>(CANONICAL_REACHABILITY_EVENT, { detail: false }),
      );
    });
    expect(result.current).toBe(false);
  });

  it('does not collapse an unverified online hint into offline', () => {
    expect(initialOnlineStatus(true)).toBeNull();
    expect(initialOnlineStatus(false)).toBe(false);
  });
});
