import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_SESSION_KEY,
  AuthLifecycleTransaction,
  TOKEN_KEY,
  authFetch,
  createStorageJournalStore,
  initPlatform,
  setOnUnauthorized,
  setSensitiveTransportAllowed,
  type PlatformDeps,
} from '@agent/shared';
import { runSavedAccountLifecycle } from './savedAccountLifecycle';

function responseWithRefresh(token: string): Response {
  return {
    status: 200,
    headers: new Headers({
      'X-Refresh-Token': token,
      'X-Auth-Epoch': '1',
      'X-Auth-Generation': '2',
    }),
  } as Response;
}

describe('Web saved-account lifecycle', () => {
  let credentials: Map<string, string>;
  let journal: Map<string, string>;
  let lifecycle: AuthLifecycleTransaction;

  beforeEach(() => {
    credentials = new Map();
    journal = new Map();
    const secureStorage = {
      getItem: async (key: string) => credentials.get(key) ?? null,
      setItem: async (key: string, value: string) => { credentials.set(key, value); },
      removeItem: async (key: string) => { credentials.delete(key); },
    };
    initPlatform({
      secureStorage,
      platformConfig: {
        platform: 'web',
        getBaseUrl: () => 'https://api.example.com',
        getWsUrl: () => '',
      },
    } as unknown as PlatformDeps);
    lifecycle = new AuthLifecycleTransaction(createStorageJournalStore({
      getItem: (key) => journal.get(key) ?? null,
      setItem: (key, value) => { journal.set(key, value); },
      removeItem: (key) => { journal.delete(key); },
    }), {
      fenceGeneration: () => undefined,
      disconnectWs: () => undefined,
      stopQueue: () => undefined,
      clearCursorEpoch: () => undefined,
      clearCache: () => undefined,
      deleteToken: async () => {
        credentials.delete(TOKEN_KEY);
        credentials.delete(AUTH_SESSION_KEY);
      },
    });
    setSensitiveTransportAllowed(true);
    setOnUnauthorized(() => undefined);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('preserves B credentials when an A refresh write is delayed across saved-account activation', async () => {
    const bindingA = JSON.stringify({ authEpoch: 1, generation: 1 });
    const bindingB = JSON.stringify({ authEpoch: 2, generation: 2 });
    credentials.set(TOKEN_KEY, 'token-a');
    credentials.set(AUTH_SESSION_KEY, bindingA);
    const platform = (await import('@agent/shared')).getPlatform();
    const originalSetItem = platform.secureStorage.setItem.bind(platform.secureStorage);
    let releaseWrite!: () => void;
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
    platform.secureStorage.setItem = async (key, value) => {
      if (key === TOKEN_KEY && value === 'stale-token-a') {
        markWriteStarted();
        await new Promise<void>((resolve) => { releaseWrite = resolve; });
      }
      await originalSetItem(key, value);
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(responseWithRefresh('stale-token-a')));

    const staleRequest = authFetch('/api/auth/me');
    const staleRejected = expect(staleRequest).rejects.toThrow('AUTH_IDENTITY_CHANGED');
    await writeStarted;
    const savedSwitch = runSavedAccountLifecycle(lifecycle, { authEpoch: 2, generation: 2 }, {
      fenceUntilCommit: () => undefined,
      persistTokenAndBinding: (binding) => {
        credentials.set(TOKEN_KEY, 'token-b');
        credentials.set(AUTH_SESSION_KEY, JSON.stringify(binding));
      },
      installAuthenticatedState: () => undefined,
      commitConnections: () => undefined,
      failClosed: () => {
        credentials.delete(TOKEN_KEY);
        credentials.delete(AUTH_SESSION_KEY);
      },
    });
    releaseWrite();

    await staleRejected;
    await savedSwitch;
    expect(credentials.get(TOKEN_KEY)).toBe('token-b');
    expect(credentials.get(AUTH_SESSION_KEY)).toBe(bindingB);
  });

  it('queues a parallel logout after saved-account activation and ends fail closed', async () => {
    const events: string[] = [];
    let releasePersist!: () => void;
    let markPersistStarted!: () => void;
    const persistStarted = new Promise<void>((resolve) => { markPersistStarted = resolve; });
    const savedSwitch = runSavedAccountLifecycle(lifecycle, { authEpoch: 2, generation: 2 }, {
      fenceUntilCommit: () => { events.push('switch:fence'); },
      persistTokenAndBinding: async (binding) => {
        events.push('switch:persist:start');
        markPersistStarted();
        await new Promise<void>((resolve) => { releasePersist = resolve; });
        credentials.set(TOKEN_KEY, 'token-b');
        credentials.set(AUTH_SESSION_KEY, JSON.stringify(binding));
        events.push('switch:persist:end');
      },
      installAuthenticatedState: () => { events.push('switch:install'); },
      commitConnections: () => { events.push('switch:commit'); },
      failClosed: () => { events.push('switch:fail'); },
    });
    await persistStarted;
    const logout = lifecycle.logout().then(() => { events.push('logout:commit'); });
    releasePersist();

    await Promise.all([savedSwitch, logout]);
    expect(events).toEqual([
      'switch:fence', 'switch:persist:start', 'switch:persist:end',
      'switch:install', 'switch:commit', 'logout:commit',
    ]);
    expect(credentials.has(TOKEN_KEY)).toBe(false);
    expect(credentials.has(AUTH_SESSION_KEY)).toBe(false);
  });
});
