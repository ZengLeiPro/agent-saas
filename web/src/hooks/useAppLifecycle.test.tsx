import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lifecycleMocks = vi.hoisted(() => ({
  connected: true,
  send: vi.fn(() => true),
  disconnect: vi.fn(),
  forceReconnect: vi.fn(async () => undefined),
  suspend: vi.fn(),
  resume: vi.fn(),
}));

vi.mock('@agent/shared', () => ({
  wsClient: {
    get isConnected() {
      return lifecycleMocks.connected;
    },
    send: lifecycleMocks.send,
    disconnect: () => {
      lifecycleMocks.connected = false;
      lifecycleMocks.disconnect();
    },
    forceReconnect: async () => {
      await lifecycleMocks.forceReconnect();
      lifecycleMocks.connected = true;
    },
    suspendNonEssentialTransport: lifecycleMocks.suspend,
    resumeNonEssentialTransport: lifecycleMocks.resume,
  },
}));

import { useAppLifecycle } from './useAppLifecycle';

let visibilityState: DocumentVisibilityState;
let online: boolean;

function setVisibility(next: DocumentVisibilityState) {
  visibilityState = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

async function flushRecovery() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(750);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  visibilityState = 'visible';
  online = true;
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibilityState,
  });
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    get: () => online,
  });
  lifecycleMocks.connected = true;
  lifecycleMocks.send.mockClear();
  lifecycleMocks.disconnect.mockClear();
  lifecycleMocks.forceReconnect.mockClear();
  lifecycleMocks.suspend.mockClear();
  lifecycleMocks.resume.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 200 })),
  );
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useAppLifecycle', () => {
  it('首次可见挂载只解除遗留 suspend，不探活、不重连、不刷新', () => {
    const onResume = vi.fn();
    renderHook(() => useAppLifecycle({ onResume, onSuspend: vi.fn() }));

    expect(lifecycleMocks.resume).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(lifecycleMocks.forceReconnect).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();
  });

  it('三秒宽限内返回时不 detach、不断连、不探活、不刷新', async () => {
    const onResume = vi.fn();
    const onSuspend = vi.fn();
    renderHook(() => useAppLifecycle({ onResume, onSuspend }));

    act(() => setVisibility('hidden'));
    await act(async () => vi.advanceTimersByTimeAsync(2_999));
    act(() => setVisibility('visible'));
    await act(async () => vi.advanceTimersByTimeAsync(1_000));

    expect(onSuspend).toHaveBeenCalledTimes(1);
    expect(lifecycleMocks.send).not.toHaveBeenCalled();
    expect(lifecycleMocks.disconnect).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(lifecycleMocks.forceReconnect).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();
  });

  it('超过传输宽限但未陈旧时只重连一次，不刷新数据', async () => {
    const onResume = vi.fn();
    renderHook(() => useAppLifecycle({ onResume, onSuspend: vi.fn() }));

    act(() => setVisibility('hidden'));
    await act(async () => vi.advanceTimersByTimeAsync(3_001));
    expect(lifecycleMocks.send).toHaveBeenCalledWith({ action: 'detach' });
    expect(lifecycleMocks.disconnect).toHaveBeenCalledTimes(1);

    act(() => setVisibility('visible'));
    await flushRecovery();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(lifecycleMocks.forceReconnect).toHaveBeenCalledTimes(1);
    expect(onResume).not.toHaveBeenCalled();
  });

  it('后台超过 30 秒时只执行一次重连和一次陈旧数据刷新', async () => {
    const onResume = vi.fn();
    renderHook(() => useAppLifecycle({ onResume, onSuspend: vi.fn() }));

    act(() => setVisibility('hidden'));
    await act(async () => vi.advanceTimersByTimeAsync(30_001));
    act(() => setVisibility('visible'));
    await flushRecovery();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(lifecycleMocks.forceReconnect).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('visible、online 和 bfcache 连续到达时合并为一个恢复周期', async () => {
    const onResume = vi.fn();
    renderHook(() => useAppLifecycle({ onResume, onSuspend: vi.fn() }));

    act(() => setVisibility('hidden'));
    await act(async () => vi.advanceTimersByTimeAsync(3_001));
    act(() => {
      setVisibility('visible');
      window.dispatchEvent(new Event('online'));
      const pageShow = new Event('pageshow');
      Object.defineProperty(pageShow, 'persisted', { value: true });
      window.dispatchEvent(pageShow);
    });
    await flushRecovery();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(lifecycleMocks.forceReconnect).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('健康检查失败也会先解除 transport suspend，并按受控退避自行恢复', async () => {
    const onResume = vi.fn();
    vi.mocked(fetch)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    renderHook(() => useAppLifecycle({ onResume, onSuspend: vi.fn() }));

    act(() => setVisibility('hidden'));
    await act(async () => vi.advanceTimersByTimeAsync(3_001));
    act(() => setVisibility('visible'));
    await flushRecovery();
    expect(lifecycleMocks.resume).toHaveBeenCalled();
    expect(lifecycleMocks.forceReconnect).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
    });
    expect(lifecycleMocks.forceReconnect).toHaveBeenCalledTimes(1);
  });

  it('长后台离线返回时保留陈旧标记，恢复在线后刷新一次', async () => {
    const onResume = vi.fn();
    renderHook(() => useAppLifecycle({ onResume, onSuspend: vi.fn() }));

    act(() => setVisibility('hidden'));
    await act(async () => vi.advanceTimersByTimeAsync(30_001));
    online = false;
    act(() => setVisibility('visible'));
    expect(fetch).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();

    online = true;
    act(() => window.dispatchEvent(new Event('online')));
    await flushRecovery();
    expect(lifecycleMocks.forceReconnect).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('连接对象仍为 open 时，重新 online 仍探活但不强制重连或刷新', async () => {
    const onResume = vi.fn();
    renderHook(() => useAppLifecycle({ onResume, onSuspend: vi.fn() }));

    online = false;
    act(() => window.dispatchEvent(new Event('offline')));
    expect(lifecycleMocks.suspend).toHaveBeenCalledTimes(1);

    online = true;
    act(() => window.dispatchEvent(new Event('online')));
    await flushRecovery();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(lifecycleMocks.forceReconnect).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();
  });

  it('health 进行中到达 online/pageshow 仍只执行一次探活和重连', async () => {
    let resolveHealth!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveHealth = resolve;
        }),
    );
    const onResume = vi.fn();
    renderHook(() => useAppLifecycle({ onResume, onSuspend: vi.fn() }));

    act(() => setVisibility('hidden'));
    await act(async () => vi.advanceTimersByTimeAsync(3_001));
    act(() => setVisibility('visible'));
    await act(async () => vi.advanceTimersByTimeAsync(750));
    act(() => {
      window.dispatchEvent(new Event('online'));
      const pageShow = new Event('pageshow');
      Object.defineProperty(pageShow, 'persisted', { value: true });
      window.dispatchEvent(pageShow);
    });
    await act(async () => {
      resolveHealth(new Response(null, { status: 200 }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(lifecycleMocks.forceReconnect).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('forceReconnect pending 时的新恢复事件不会启动第二次重连', async () => {
    let resolveReconnect!: () => void;
    lifecycleMocks.forceReconnect.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          resolveReconnect = () => resolve(undefined);
        }),
    );
    renderHook(() => useAppLifecycle({ onResume: vi.fn(), onSuspend: vi.fn() }));

    act(() => setVisibility('hidden'));
    await act(async () => vi.advanceTimersByTimeAsync(3_001));
    act(() => setVisibility('visible'));
    await flushRecovery();
    expect(lifecycleMocks.forceReconnect).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event('online'));
      const pageShow = new Event('pageshow');
      Object.defineProperty(pageShow, 'persisted', { value: true });
      window.dispatchEvent(pageShow);
    });
    await act(async () => {
      resolveReconnect();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => vi.advanceTimersByTimeAsync(1_000));

    expect(lifecycleMocks.forceReconnect).toHaveBeenCalledTimes(1);
  });

  it('探活尚未完成时再次隐藏会阻止迟到响应重连或刷新', async () => {
    let resolveHealth!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveHealth = resolve;
        }),
    );
    const onResume = vi.fn();
    renderHook(() => useAppLifecycle({ onResume, onSuspend: vi.fn() }));

    act(() => setVisibility('hidden'));
    await act(async () => vi.advanceTimersByTimeAsync(30_001));
    act(() => setVisibility('visible'));
    await act(async () => vi.advanceTimersByTimeAsync(750));
    expect(fetch).toHaveBeenCalledTimes(1);

    act(() => setVisibility('hidden'));
    await act(async () => {
      resolveHealth(new Response(null, { status: 200 }));
      await Promise.resolve();
    });

    expect(lifecycleMocks.forceReconnect).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();
  });
});
