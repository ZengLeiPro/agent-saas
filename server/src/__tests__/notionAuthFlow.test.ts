import { describe, expect, it, vi } from 'vitest';

import type { UserInfo } from '../data/users/types.js';
import type { DwsAuthSessionIdentity, DwsAuthSessionRecord, DwsAuthSessionStore } from '../dws/authStore.js';
import {
  NotionAuthFlowService,
  parseNotionDeviceAuthorization,
  type NotionDeviceLoginRunnerLike,
} from '../notion/authFlow.js';

function user(): UserInfo {
  return {
    id: 'user-1',
    username: 'alice',
    tenantId: 'tenant-a',
    role: 'user',
    disabled: false,
  } as UserInfo;
}

function session(): DwsAuthSessionRecord {
  const now = new Date();
  return {
    sessionId: 'session-1',
    tenantId: 'tenant-a',
    userId: 'user-1',
    username: 'alice',
    status: 'starting',
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

describe('Notion official CLI auth flow', () => {
  it('parses the official ntn verification URL and code', () => {
    expect(parseNotionDeviceAuthorization(`
Open this URL in your browser to continue:
https://www.notion.so/install-integration?verificationCode=83GJ-T6GJ

Verification code: 83GJ-T6GJ
`)).toEqual({
      authorizationUrl: 'https://www.notion.so/install-integration?verificationCode=83GJ-T6GJ',
      userCode: '83GJ-T6GJ',
    });
    expect(parseNotionDeviceAuthorization('no authorization here')).toBeNull();
  });

  it('passes the token only to the Vault callback and never persists it in auth session state', async () => {
    const row = session();
    const latest = { value: row as DwsAuthSessionRecord | null };
    const markAwaitingUser = vi.fn(async (
      _sessionId: string,
      _identity: DwsAuthSessionIdentity,
      userCode: string,
      authorizationUrl: string,
    ) => {
      latest.value = { ...row, status: 'awaiting_user', userCode, authorizationUrl };
      return latest.value;
    });
    const store = {
      createOrReuse: vi.fn(async () => ({ record: row, created: true })),
      getLatestForUser: vi.fn(async () => latest.value),
      markAwaitingUser,
      markConnected: vi.fn(async () => {
        latest.value = { ...row, status: 'connected' };
        return latest.value;
      }),
      markFailed: vi.fn(async () => row),
    } as unknown as DwsAuthSessionStore;
    const runner: NotionDeviceLoginRunnerLike = {
      login: vi.fn(async (_user, onAuthorization) => {
        await onAuthorization({
          authorizationUrl: 'https://www.notion.so/install-integration?verificationCode=83GJ-T6GJ',
          userCode: '83GJ-T6GJ',
        });
        return 'ntn_secret_token';
      }),
    };
    const onCredential = vi.fn(async () => undefined);
    const service = new NotionAuthFlowService({ authSessionStore: store, runner, onCredential });

    await service.start(user());
    await vi.waitFor(() => expect(onCredential).toHaveBeenCalledWith(expect.objectContaining({ username: 'alice' }), 'ntn_secret_token'));
    await vi.waitFor(() => expect(store.markConnected).toHaveBeenCalled());

    expect(JSON.stringify(latest.value)).not.toContain('ntn_secret_token');
    expect(JSON.stringify(markAwaitingUser.mock.calls)).not.toContain('ntn_secret_token');
  });

  it('cancels and awaits an active login before user deletion can continue', async () => {
    const row = session();
    const store = {
      createOrReuse: vi.fn(async () => ({ record: row, created: true })),
      getLatestForUser: vi.fn(async () => row),
      markAwaitingUser: vi.fn(async () => row),
      markConnected: vi.fn(async () => row),
      markFailed: vi.fn(async () => row),
    } as unknown as DwsAuthSessionStore;
    const onCredential = vi.fn(async () => undefined);
    const runner: NotionDeviceLoginRunnerLike = {
      login: vi.fn(async (_user, _onAuthorization, signal) => await new Promise<string>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })),
    };
    const service = new NotionAuthFlowService({ authSessionStore: store, runner, onCredential });

    await service.start(user());
    await service.cancelUser('tenant-a', 'user-1');

    expect(onCredential).not.toHaveBeenCalled();
    expect(store.markConnected).not.toHaveBeenCalled();
    expect(store.markFailed).toHaveBeenCalled();
  });

  it('marks a failed CLI login without exposing the provider error', async () => {
    const row = session();
    const store = {
      createOrReuse: vi.fn(async () => ({ record: row, created: true })),
      getLatestForUser: vi.fn(async () => row),
      markAwaitingUser: vi.fn(async () => row),
      markConnected: vi.fn(async () => row),
      markFailed: vi.fn(async () => row),
    } as unknown as DwsAuthSessionStore;
    const runner: NotionDeviceLoginRunnerLike = {
      login: vi.fn(async () => { throw new Error('Bearer ntn_super_secret'); }),
    };
    const service = new NotionAuthFlowService({
      authSessionStore: store,
      runner,
      onCredential: vi.fn(async () => undefined),
    });

    await service.start(user());
    await vi.waitFor(() => expect(store.markFailed).toHaveBeenCalled());
    expect(store.markFailed).toHaveBeenCalledWith(
      'session-1',
      expect.anything(),
      'authorization_failed',
      'Notion 授权未完成，请重试',
    );
  });
});
