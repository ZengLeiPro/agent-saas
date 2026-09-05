import { describe, expect, it } from 'vitest';

import { InMemoryKyAppNonceStore } from './nonceStore.js';

const binding = {
  nonce: 'nonce-0123456789abcdefghij',
  installationId: 'tsi_01',
  tenantId: 't_demo',
  userId: 'u_1',
  sessionId: 'sess_1',
};

describe('握手 nonce 原子消费（规范 §5.4）', () => {
  it('只能消费一次，过期与未知一律 null', async () => {
    const store = new InMemoryKyAppNonceStore();
    const now = new Date('2026-09-06T00:00:00Z');
    await store.issue({ ...binding, expiresAt: new Date(now.getTime() + 60_000) });

    const first = await store.consume(binding.nonce, now);
    expect(first).toMatchObject({ installationId: 'tsi_01', userId: 'u_1', sessionId: 'sess_1' });
    expect(await store.consume(binding.nonce, now)).toBeNull();
    expect(await store.consume('unknown-nonce-0123456789', now)).toBeNull();
  });

  it('过期的 nonce 不可消费，purgeExpired 清掉它', async () => {
    const store = new InMemoryKyAppNonceStore();
    const now = new Date('2026-09-06T00:00:00Z');
    await store.issue({ ...binding, expiresAt: new Date(now.getTime() - 1) });
    expect(await store.consume(binding.nonce, now)).toBeNull();
    expect(await store.purgeExpired(now)).toBe(1);
    expect(await store.purgeExpired(now)).toBe(0);
  });
});
