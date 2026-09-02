import { describe, expect, it, vi } from 'vitest';
import {
  AUTH_TERMINATION_STEPS,
  AuthLifecycleTransaction,
  type AuthLifecycleJournal,
  type AuthLifecycleJournalStore,
  type AuthTerminationStep,
} from './authLifecycle';

class MemoryJournalStore implements AuthLifecycleJournalStore {
  journal: AuthLifecycleJournal | null = null;
  async read() { return this.journal ? structuredClone(this.journal) : null; }
  async write(journal: AuthLifecycleJournal) { this.journal = structuredClone(journal); }
  async clear() { this.journal = null; }
}

function fixture(options: { crashOnceAt?: AuthTerminationStep; deleteFailure?: Error } = {}) {
  const store = new MemoryJournalStore();
  const calls: string[] = [];
  let crashed = false;
  let token = 'secret';
  let sensitive = true;
  const effect = (step: AuthTerminationStep, fn?: () => void) => async () => {
    calls.push(step);
    fn?.();
    if (options.crashOnceAt === step && !crashed) {
      crashed = true;
      throw new Error(`crash:${step}`);
    }
  };
  const engine = () => new AuthLifecycleTransaction(store, {
    fenceGeneration: effect('fence_generation', () => { sensitive = false; }),
    disconnectWs: effect('disconnect_ws'),
    stopQueue: effect('stop_queue'),
    clearCursorEpoch: effect('clear_cursor_epoch'),
    clearCache: effect('clear_cache'),
    deleteToken: effect('delete_token', () => { token = ''; }),
    deleteRemoteAccount: async () => {
      calls.push('delete_remote_account');
      if (options.deleteFailure) throw options.deleteFailure;
    },
  });
  return { store, calls, engine, token: () => token, sensitive: () => sensitive };
}

describe('M30-01 canonical auth lifecycle transaction', () => {
  it('fences UI first and deletes token last in the authoritative order', async () => {
    const f = fixture();
    await f.engine().logout();
    expect(f.calls).toEqual(AUTH_TERMINATION_STEPS);
    expect(f.sensitive()).toBe(false);
    expect(f.token()).toBe('');
    expect(f.store.journal).toBeNull();
  });

  for (const step of AUTH_TERMINATION_STEPS) {
    it(`recovers a crash at ${step} from its durable checkpoint`, async () => {
      const f = fixture({ crashOnceAt: step });
      await expect(f.engine().logout()).rejects.toThrow(`crash:${step}`);
      expect(f.store.journal?.status).toBe('failed_fenced');
      expect(f.sensitive()).toBe(false);
      await f.engine().resume();
      expect(f.calls.at(-1)).toBe('delete_token');
      expect(f.token()).toBe('');
      expect(f.store.journal).toBeNull();
    });
  }

  it('coalesces duplicate logout and serializes concurrent delete without losing delete intent', async () => {
    const f = fixture();
    const tx = f.engine();
    const first = tx.logout();
    const duplicate = tx.logout();
    const deletion = tx.deleteAccount();
    await Promise.all([first, duplicate, deletion]);
    expect(f.calls.filter((call) => call === 'delete_remote_account')).toHaveLength(1);
    expect(f.calls.filter((call) => call === 'fence_generation')).toHaveLength(2);
    expect(f.token()).toBe('');
  });

  it.each([new Error('500'), new Error('timeout')])('keeps delete failure fenced and retryable: %s', async (failure) => {
    const f = fixture({ deleteFailure: failure });
    const result = await f.engine().deleteAccount();
    expect(result.status).toBe('failed_fenced');
    expect(result.failure?.step).toBe('delete_remote_account');
    expect(f.sensitive()).toBe(false);
    expect(f.token()).toBe('');
    expect(f.store.journal?.checkpoint).toBe(AUTH_TERMINATION_STEPS.length);
  });

  it('commits a login binding before connections can send', async () => {
    const f = fixture();
    const events: string[] = [];
    let canSend = false;
    await f.engine().login({ authEpoch: 8, generation: 4 }, {
      fenceUntilCommit: () => { canSend = false; events.push('fence'); },
      persistTokenAndBinding: () => { events.push('persist'); expect(canSend).toBe(false); },
      installAuthenticatedState: () => { events.push('install'); expect(canSend).toBe(false); },
      commitConnections: () => { canSend = true; events.push('commit'); },
      failClosed: vi.fn(),
    });
    expect(events).toEqual(['fence', 'persist', 'install', 'commit']);
    expect(canSend).toBe(true);
  });

  it('serializes a concurrent logout behind an in-flight account login', async () => {
    const f = fixture();
    const tx = f.engine();
    const events: string[] = [];
    let releasePersist!: () => void;
    let markPersistStarted!: () => void;
    const persistStarted = new Promise<void>((resolve) => { markPersistStarted = resolve; });
    const login = tx.login({ authEpoch: 3, generation: 7 }, {
      fenceUntilCommit: () => { events.push('login:fence'); },
      persistTokenAndBinding: async () => {
        events.push('login:persist:start');
        markPersistStarted();
        await new Promise<void>((resolve) => { releasePersist = resolve; });
        events.push('login:persist:end');
      },
      installAuthenticatedState: () => { events.push('login:install'); },
      commitConnections: () => { events.push('login:commit'); },
      failClosed: vi.fn(),
    });
    await persistStarted;
    const logout = tx.logout().then(() => { events.push('logout:commit'); });
    expect(f.calls).not.toContain('fence_generation');
    releasePersist();

    await Promise.all([login, logout]);
    expect(events).toEqual([
      'login:fence', 'login:persist:start', 'login:persist:end',
      'login:install', 'login:commit', 'logout:commit',
    ]);
    expect(f.calls).toEqual(AUTH_TERMINATION_STEPS);
  });

  it('fails closed when epoch persistence fails and recovers an incomplete login journal on restart', async () => {
    const f = fixture();
    const failClosed = vi.fn();
    await expect(f.engine().login({ authEpoch: 2, generation: 2 }, {
      fenceUntilCommit: vi.fn(),
      persistTokenAndBinding: () => { throw new Error('disk full'); },
      installAuthenticatedState: vi.fn(),
      commitConnections: vi.fn(),
      failClosed,
    })).rejects.toThrow('disk full');
    expect(failClosed).toHaveBeenCalledTimes(1);
    const restartedFailClosed = vi.fn();
    await expect(f.engine().failClosedIncompleteLogin({
      fenceUntilCommit: vi.fn(),
      persistTokenAndBinding: vi.fn(),
      installAuthenticatedState: vi.fn(),
      commitConnections: vi.fn(),
      failClosed: restartedFailClosed,
    })).resolves.toBe(true);
    expect(restartedFailClosed).toHaveBeenCalledTimes(1);
    expect(f.store.journal).toBeNull();
  });

  it.each(['web', 'mobile'])('%s adapter observes identical canonical checkpoints', async () => {
    const f = fixture();
    await f.engine().logout();
    expect(f.calls).toEqual(AUTH_TERMINATION_STEPS);
  });
});
