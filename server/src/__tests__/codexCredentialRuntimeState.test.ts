import { afterEach, describe, expect, it, vi } from 'vitest';

import { InMemoryCodexCredentialRuntimeStateStore } from '../runtime/responses/codexCredentialRuntimeState.js';

describe('Codex credential runtime state store', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('共享接口记录额度冷却并在到期后自动清除', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T12:00:00.000Z'));
    const store = new InMemoryCodexCredentialRuntimeStateStore();

    await store.markQuotaCooldown(
      'credential-a',
      '2026-09-02T12:10:00.000Z',
      'insufficient_quota',
      1,
    );
    await expect(store.get('credential-a')).resolves.toMatchObject({
      availability: 'quota_cooldown',
      lastFailureCode: 'insufficient_quota',
    });

    vi.setSystemTime(new Date('2026-09-02T12:10:01.000Z'));
    await expect(store.get('credential-a')).resolves.toBeUndefined();
  });

  it('授权异常保持到重授权显式清除', async () => {
    const store = new InMemoryCodexCredentialRuntimeStateStore();

    await store.markAuthUnavailable('credential-a', 'invalid_grant', 2);
    await expect(store.get('credential-a')).resolves.toEqual({
      credentialRef: 'credential-a',
      availability: 'auth_unavailable',
      credentialGeneration: 2,
      lastFailureCode: 'invalid_grant',
    });

    await store.clear('credential-a');
    await expect(store.get('credential-a')).resolves.toBeUndefined();
  });

  it('重授权后拒绝旧请求回写运行状态', async () => {
    const store = new InMemoryCodexCredentialRuntimeStateStore();

    await store.markAuthUnavailable('credential-a', 'invalid_grant', 1);
    await store.clear('credential-a', 2);
    await store.markQuotaCooldown(
      'credential-a',
      '2026-09-02T12:10:00.000Z',
      'insufficient_quota',
      1,
    );
    await store.markAuthUnavailable('credential-a', 'invalid_grant', 1);

    await expect(store.get('credential-a')).resolves.toBeUndefined();
  });
});
