import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAppConfig } from '../app/config.js';
import { InMemorySecretVault, type SecretRef } from '../security/secretVault.js';
import { computeObservedConfigIdentity } from '../release/configIdentity.js';
import { createConfigIdentityRuntime } from './configIdentityRuntime.js';
import { ConfigObservationTimeout, observeWithinDeadline } from './configObservationDeadline.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function fixture() {
  const vault = new InMemorySecretVault();
  const ref = await vault.putSecret('global', 'tenant-hand', 'not-a-real-secret', {
    actor: 'system',
    userId: '__system__',
    scopes: ['secret:tenant-hand:write'],
  });
  const config = parseAppConfig({
    agent: { cwd: '/srv/agent' },
    server: {},
    runtimeEventStore: {
      backend: 'pg',
      connectionString: 'postgresql://u:p@db.internal:5432/runtime',
    },
    tenantRemoteHands: {
      hands: [{ id: 'h1', baseUrl: 'https://acs.internal', authTokenRef: ref.id }],
    },
  });
  const observation = await computeObservedConfigIdentity(config, vault, '/srv/server');
  const updates: string[] = [];
  const runtime = createConfigIdentityRuntime({
    config,
    secretVault: vault,
    environment: 'production',
    processCwd: '/srv/server',
    expected: {
      schemaVersion: 1,
      digest: observation.digest,
      credentialVersionDigest: observation.credentialVersionDigest ?? undefined,
    },
    observationTimeoutMs: 100,
    releaseId: 'rc-20260911-117',
    onSummaryUpdated: (summary) => {
      updates.push(summary.status);
    },
  });
  return { vault, ref, config, runtime, updates };
}

describe('whole ConfigIdentity observation deadline', () => {
  it('hung inspection releases the strong refresh and a later normal refresh recovers', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    await f.runtime.initialize();
    expect(f.runtime.getSummary().status).toBe('consistent');
    await vi.advanceTimersByTimeAsync(5_001);
    const delayed = deferred<SecretRef | null>();
    const spy = vi.spyOn(f.vault, 'inspectRef').mockImplementationOnce(() => delayed.promise);
    let settled = false;
    const read = f.runtime.refreshSummary().then((value) => {
      settled = true;
      return value;
    });
    try {
      await vi.advanceTimersByTimeAsync(101);
      // This assertion fails on the unmodified source: its activeRefresh never finishes.
      expect(settled).toBe(true);
      expect((await read).status).toBe('not_collected');
      expect(f.runtime.getRefreshFailure()).toBe('config_refresh_timeout');
      expect(f.updates.at(-1)).toBe('not_collected');
      spy.mockRestore();
      expect((await f.runtime.refreshSummary()).status).toBe('consistent');
      expect(f.runtime.getRefreshFailure()).toBeUndefined();
      const afterRecovery = f.runtime.getSummary();
      delayed.resolve(null);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.runtime.getSummary()).toEqual(afterRecovery);
      await vi.advanceTimersByTimeAsync(5_001);
      expect((await f.runtime.refreshSummary()).status).toBe('consistent');
    } finally {
      delayed.resolve(null);
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it('a late failed inspection cannot overwrite a newer successful generation', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    await f.runtime.initialize();
    await vi.advanceTimersByTimeAsync(5_001);
    const delayed = deferred<SecretRef | null>();
    const spy = vi.spyOn(f.vault, 'inspectRef').mockImplementationOnce(() => delayed.promise);
    const old = f.runtime.refreshSummary();
    await vi.advanceTimersByTimeAsync(101);
    expect((await old).status).toBe('not_collected');
    spy.mockRestore();
    await f.runtime.refreshSummary();
    const recovered = f.runtime.getSummary();
    delayed.reject(new Error('late remote failure'));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.runtime.getSummary()).toEqual(recovered);
    expect(f.runtime.getRefreshFailure()).toBeUndefined();
  });

  it('startup is bounded but never accepts an unverified managed credential', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const delayed = deferred<SecretRef | null>();
    vi.spyOn(f.vault, 'inspectRef').mockImplementationOnce(() => delayed.promise);
    const initial = expect(f.runtime.initialize()).rejects.toBeInstanceOf(ConfigObservationTimeout);
    await vi.advanceTimersByTimeAsync(101);
    await initial;
    expect(f.runtime.getSummary().status).toBe('not_collected');
    delayed.resolve(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.runtime.getSummary().status).toBe('not_collected');
  });

  it('candidate validation timeout cannot publish an unapproved config', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    await f.runtime.initialize();
    const before = f.runtime.getSummary();
    const delayed = deferred<SecretRef | null>();
    vi.spyOn(f.vault, 'inspectRef').mockImplementationOnce(() => delayed.promise);
    const check = expect(f.runtime.validateConfigReload(f.config)).rejects.toBeInstanceOf(
      ConfigObservationTimeout,
    );
    await vi.advanceTimersByTimeAsync(101);
    await check;
    expect(f.runtime.getSummary()).toEqual(before);
    delayed.resolve(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.runtime.getSummary()).toEqual(before);
  });

  it('candidate invalidation still prevents speculative automatic observation', async () => {
    const f = await fixture();
    await f.runtime.initialize();
    f.runtime.invalidateObservation();
    const spy = vi.spyOn(f.vault, 'inspectRef');
    expect((await f.runtime.refreshSummary()).status).toBe('not_collected');
    expect(spy).not.toHaveBeenCalled();
  });

  it('fast repeated reads retain consistent identity without periodic false not_collected', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    await f.runtime.initialize();
    for (let cycle = 0; cycle < 20; cycle++) {
      await vi.advanceTimersByTimeAsync(1_001);
      expect((await f.runtime.refreshSummary()).status).toBe('consistent');
    }
    expect(f.updates).not.toContain('not_collected');
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    'rejects invalid total budget %s',
    (observationTimeoutMs) => {
      expect(() =>
        createConfigIdentityRuntime({
          config: parseAppConfig({ agent: { cwd: '/srv/agent' }, server: {} }),
          environment: 'test',
          observationTimeoutMs,
        }),
      ).toThrow('positive integer');
    },
  );

  it('clears the timer on normal success and consumes late rejection after timeout', async () => {
    vi.useFakeTimers();
    expect(await observeWithinDeadline(async () => 'ok', 100)).toBe('ok');
    expect(vi.getTimerCount()).toBe(0);
    const delayed = deferred<string>();
    const failure = expect(
      observeWithinDeadline(() => delayed.promise, 100),
    ).rejects.toBeInstanceOf(ConfigObservationTimeout);
    await vi.advanceTimersByTimeAsync(101);
    await failure;
    delayed.reject(new Error('late'));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('captures the read-only observation synchronously before caller-side config mutation', async () => {
    let value = 'before';
    const result = observeWithinDeadline(async () => value, 100);
    value = 'after';
    expect(await result).toBe('before');
  });
});
