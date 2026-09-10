import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initPlatform,
  setSensitiveTransportAllowed,
  TOKEN_KEY,
  type BoundaryIdentity,
} from '@agent/shared';

const state = vi.hoisted(() => ({
  asyncValues: new Map<string, string>(),
  files: new Map<string, string>(),
  downloads: [] as Array<{
    token: string | null;
    destination: MockFile;
    resolve: () => void;
  }>,
}));

class MockFile {
  uri: string;

  constructor(_base: unknown, relative: string) {
    this.uri = `file:///cache/${relative}`;
  }

  get exists(): boolean {
    return state.files.has(this.uri);
  }
  get size(): number | null {
    return state.files.get(this.uri)?.length ?? null;
  }
  delete(): void {
    state.files.delete(this.uri);
  }
  move(destination: MockFile): void {
    const content = state.files.get(this.uri);
    if (content === undefined) throw new Error('source file is missing');
    state.files.set(destination.uri, content);
    state.files.delete(this.uri);
    this.uri = destination.uri;
  }

  static downloadFileAsync(
    _url: string,
    destination: MockFile,
    options: { headers?: { Authorization?: string } },
  ): Promise<MockFile> {
    const authorization = options.headers?.Authorization ?? null;
    const token = authorization?.replace(/^Bearer /u, '') ?? null;
    return new Promise((resolve) => {
      state.downloads.push({
        token,
        destination,
        resolve: () => {
          state.files.set(destination.uri, `PRIVATE_${token ?? 'ANON'}`);
          resolve(destination);
        },
      });
    });
  }
}

vi.mock('expo-file-system', () => ({
  Paths: { cache: '/cache' },
  File: MockFile,
  Directory: class MockDirectory {
    uri: string;
    constructor(_base: unknown, relative: string) {
      this.uri = `file:///cache/${relative}`;
    }
    get exists(): boolean {
      return [...state.files].some(([key]) => key.startsWith(`${this.uri}/`));
    }
    create(): void {}
    delete(): void {
      for (const key of [...state.files.keys()]) {
        if (key.startsWith(`${this.uri}/`)) state.files.delete(key);
      }
    }
  },
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => state.asyncValues.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      state.asyncValues.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      state.asyncValues.delete(key);
    }),
  },
}));

const identityA: BoundaryIdentity = { tenantId: 'tenant-a', userId: 'user-a', generation: 1 };
const identityB: BoundaryIdentity = { tenantId: 'tenant-b', userId: 'user-b', generation: 2 };

describe('FileCacheService identity isolation', () => {
  beforeEach(async () => {
    state.asyncValues.clear();
    state.files.clear();
    state.downloads.length = 0;
    const tokenStore = new Map<string, string>([[TOKEN_KEY, 'TOKEN_A']]);
    initPlatform({
      storage: {} as never,
      secureStorage: {
        getItem: async (key: string) => tokenStore.get(key) ?? null,
        setItem: async (key: string, value: string) => {
          tokenStore.set(key, value);
        },
        removeItem: async (key: string) => {
          tokenStore.delete(key);
        },
      },
      messageCache: {} as never,
      platformConfig: {
        getBaseUrl: () => 'https://api.example.com',
        getWsUrl: () => 'wss://api.example.com/ws',
        platform: 'mobile',
        assertTrustedUrl: () => undefined,
      },
      scheduleFlush: () => 0,
      cancelFlush: () => undefined,
    });
    setSensitiveTransportAllowed(true);
    const { fileCacheService } = await import('./fileCacheService');
    fileCacheService.setIdentity(null);
    await fileCacheService.clearAll();
  });

  it('does not reuse A inflight after logout and B login, and discards A late completion', async () => {
    const { fileCacheService } = await import('./fileCacheService');
    fileCacheService.setIdentity(identityA);
    const downloadA = fileCacheService.getOrDownload('reports/shared.pdf', 1, 9, 'alice');
    await vi.waitFor(() => expect(state.downloads).toHaveLength(1));

    await fileCacheService.clearAll();
    fileCacheService.setIdentity(identityB);
    const platform = (await import('@agent/shared')).getPlatform();
    await platform.secureStorage.setItem(TOKEN_KEY, 'TOKEN_B');
    const downloadB = fileCacheService.getOrDownload('reports/shared.pdf', 1, 9, 'alice');
    await vi.waitFor(() => expect(state.downloads).toHaveLength(2));

    state.downloads[0].resolve();
    await expect(downloadA).rejects.toThrow('FILE_CACHE_IDENTITY_CHANGED');
    expect([...state.files.values()]).not.toContain('PRIVATE_TOKEN_A');

    const downloadBJoiner = fileCacheService.getOrDownload('reports/shared.pdf', 1, 9, 'alice');
    await Promise.resolve();
    expect(state.downloads).toHaveLength(2);

    state.downloads[1].resolve();
    const uriB = await downloadB;
    await expect(downloadBJoiner).resolves.toBe(uriB);
    expect(state.files.get(uriB)).toBe('PRIVATE_TOKEN_B');
    expect(state.downloads.map((item) => item.token)).toEqual(['TOKEN_A', 'TOKEN_B']);
  });

  it('uses collision-resistant names for the legacy DJB2 collision paths', async () => {
    const { fileCacheService } = await import('./fileCacheService');
    fileCacheService.setIdentity(identityA);
    const first = fileCacheService.getOrDownload('reports/Aa.pdf', 1, 9, 'alice');
    await vi.waitFor(() => expect(state.downloads).toHaveLength(1));
    state.downloads[0].resolve();
    const firstUri = await first;

    const second = fileCacheService.getOrDownload('reports/B@.pdf', 1, 9, 'alice');
    await vi.waitFor(() => expect(state.downloads).toHaveLength(2));
    state.downloads[1].resolve();
    const secondUri = await second;

    expect(firstUri).not.toBe(secondUri);
    expect(firstUri).toMatch(/[a-f0-9]{64}\.pdf$/u);
    expect(secondUri).toMatch(/[a-f0-9]{64}\.pdf$/u);
  });

  it('never reuses a tenant A KB cache entry for tenant B', async () => {
    const { fileCacheService } = await import('./fileCacheService');
    fileCacheService.setIdentity(identityA);
    const first = fileCacheService.getOrDownload('kb://shared.pdf', 1, 9);
    await vi.waitFor(() => expect(state.downloads).toHaveLength(1));
    state.downloads[0].resolve();
    const firstUri = await first;

    fileCacheService.setIdentity(identityB);
    const platform = (await import('@agent/shared')).getPlatform();
    await platform.secureStorage.setItem(TOKEN_KEY, 'TOKEN_B');
    const second = fileCacheService.getOrDownload('kb://shared.pdf', 1, 9);
    await vi.waitFor(() => expect(state.downloads).toHaveLength(2));
    state.downloads[1].resolve();
    const secondUri = await second;

    expect(secondUri).not.toBe(firstUri);
    expect(state.files.get(secondUri)).toBe('PRIVATE_TOKEN_B');
  });

  it('rejects and deletes a late attachment download after the identity changes', async () => {
    const { fileCacheService } = await import('./fileCacheService');
    fileCacheService.setIdentity(identityA);
    const pending = fileCacheService.getOrDownloadAttachment(
      '123e4567-e89b-12d3-a456-426614174000',
      'private.pdf',
    );
    await vi.waitFor(() => expect(state.downloads).toHaveLength(1));

    fileCacheService.setIdentity(identityB);
    state.downloads[0].resolve();

    await expect(pending).rejects.toThrow('FILE_CACHE_IDENTITY_CHANGED');
    expect([...state.files.values()]).not.toContain('PRIVATE_TOKEN_A');
  });
});
