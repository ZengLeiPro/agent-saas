/** M30-01 canonical, crash-recoverable authentication lifecycle transaction. */
export const AUTH_LIFECYCLE_JOURNAL_KEY = 'agentChat.authLifecycle.v1';
export const AUTH_SESSION_KEY = 'agentChat.authSession.v1';

export interface AuthSessionBinding {
  authEpoch: number;
  generation: number;
}

export type AuthLifecycleOperation = 'login' | 'logout' | 'delete_account';
export type AuthLifecycleStatus = 'running' | 'committed' | 'failed_fenced';
export type AuthTerminationStep =
  | 'fence_generation'
  | 'disconnect_ws'
  | 'stop_queue'
  | 'clear_cursor_epoch'
  | 'clear_cache'
  | 'delete_token';

export const AUTH_TERMINATION_STEPS: readonly AuthTerminationStep[] = Object.freeze([
  'fence_generation',
  'disconnect_ws',
  'stop_queue',
  'clear_cursor_epoch',
  'clear_cache',
  'delete_token',
]);

export interface AuthLifecycleJournal {
  version: 1;
  transactionId: string;
  operation: AuthLifecycleOperation;
  status: AuthLifecycleStatus;
  /** Number of durably completed canonical steps; recovery starts here. */
  checkpoint: number;
  startedAt: string;
  updatedAt: string;
  binding?: AuthSessionBinding;
  failure?: { step: string; message: string };
}

export interface AuthLifecycleJournalStore {
  read(): Promise<AuthLifecycleJournal | null>;
  write(journal: AuthLifecycleJournal): Promise<void>;
  clear(): Promise<void>;
}

export interface AuthTerminationEffects {
  fenceGeneration(): void | Promise<void>;
  disconnectWs(): void | Promise<void>;
  stopQueue(): void | Promise<void>;
  clearCursorEpoch(): void | Promise<void>;
  clearCache(): void | Promise<void>;
  deleteToken(): void | Promise<void>;
  deleteRemoteAccount?(): void | Promise<void>;
}

export interface AuthLoginEffects {
  fenceUntilCommit(): void | Promise<void>;
  persistTokenAndBinding(binding: AuthSessionBinding): void | Promise<void>;
  installAuthenticatedState(binding: AuthSessionBinding): void | Promise<void>;
  commitConnections(binding: AuthSessionBinding): void | Promise<void>;
  failClosed(): void | Promise<void>;
}

export class AuthLifecycleBusyError extends Error {
  constructor() { super('AUTH_LIFECYCLE_TRANSACTION_BUSY'); }
}

function transactionId(): string {
  return `auth-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Serializes login/logout/delete across Web and Mobile. A checkpoint is written
 * after every effect, so replay starts at the first effect not known durable.
 */
export class AuthLifecycleTransaction {
  private active: Promise<AuthLifecycleJournal> | null = null;
  private activeOperation: AuthLifecycleOperation | null = null;

  constructor(
    private readonly store: AuthLifecycleJournalStore,
    private readonly termination: AuthTerminationEffects,
  ) {}

  private serialize(operation: AuthLifecycleOperation, run: () => Promise<AuthLifecycleJournal>): Promise<AuthLifecycleJournal> {
    if (this.active) {
      // Login effects carry the target principal and credentials. Operation equality
      // alone cannot prove two login intents are identical, so never coalesce them.
      if (operation === this.activeOperation && operation !== 'login') return this.active;
      const previous = this.active;
      const queued = previous.then(run, run).finally(() => {
        if (this.active === queued) {
          this.active = null;
          this.activeOperation = null;
        }
      });
      this.active = queued;
      this.activeOperation = operation;
      return queued;
    }
    const promise = run().finally(() => {
      if (this.active === promise) {
        this.active = null;
        this.activeOperation = null;
      }
    });
    this.active = promise;
    this.activeOperation = operation;
    return promise;
  }

  logout(): Promise<AuthLifecycleJournal> {
    return this.serialize('logout', async () => this.runTermination('logout'));
  }

  deleteAccount(): Promise<AuthLifecycleJournal> {
    return this.serialize('delete_account', async () => this.runTermination('delete_account'));
  }

  resume(): Promise<AuthLifecycleJournal | null> { // startup recovery entrypoint
    if (this.active) return this.active;
    return this.store.read().then(async (journal) => {
      if (!journal) return null;
      if (journal.status === 'committed') {
        await this.store.clear();
        return null;
      }
      if (journal.operation === 'login') return null; // login recovery is fail-closed below
      const operation: 'logout' | 'delete_account' = journal.operation;
      return this.serialize(operation, async () => this.runTermination(operation, journal));
    });
  }

  async failClosedIncompleteLogin(login: AuthLoginEffects): Promise<boolean> {
    const journal = await this.store.read();
    if (!journal || journal.operation !== 'login' || journal.status === 'committed') return false;
    await login.fenceUntilCommit();
    await login.failClosed();
    await this.store.clear();
    return true;
  }

  login(binding: AuthSessionBinding, effects: AuthLoginEffects): Promise<AuthLifecycleJournal> {
    return this.serialize('login', async () => {
      if (!Number.isSafeInteger(binding.authEpoch) || binding.authEpoch < 1
        || !Number.isSafeInteger(binding.generation) || binding.generation < 1) {
        await effects.fenceUntilCommit();
        await effects.failClosed();
        throw new Error('AUTH_BINDING_INVALID');
      }
      let journal: AuthLifecycleJournal = {
        version: 1,
        transactionId: transactionId(),
        operation: 'login',
        status: 'running',
        checkpoint: 0,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        binding,
      };
      await effects.fenceUntilCommit();
      await this.store.write(journal);
      try {
        await effects.persistTokenAndBinding(binding);
        journal = await this.checkpoint(journal, 1);
        await effects.installAuthenticatedState(binding);
        journal = await this.checkpoint(journal, 2);
        journal = { ...journal, status: 'committed', checkpoint: 3, updatedAt: new Date().toISOString() };
        await this.store.write(journal);
        await effects.commitConnections(binding);
        await this.store.clear();
        return journal;
      } catch (error) {
        await effects.failClosed();
        const failed = { ...journal, status: 'failed_fenced' as const, failure: { step: 'login', message: errorMessage(error) }, updatedAt: new Date().toISOString() };
        await this.store.write(failed);
        throw error;
      }
    });
  }

  private async runTermination(
    operation: 'logout' | 'delete_account',
    existing?: AuthLifecycleJournal,
  ): Promise<AuthLifecycleJournal> {
    let journal = existing ?? {
      version: 1 as const,
      transactionId: transactionId(),
      operation,
      status: 'running' as const,
      checkpoint: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (!existing) await this.store.write(journal);
    const effects: Record<AuthTerminationStep, () => void | Promise<void>> = {
      fence_generation: () => this.termination.fenceGeneration(),
      disconnect_ws: () => this.termination.disconnectWs(),
      stop_queue: () => this.termination.stopQueue(),
      clear_cursor_epoch: () => this.termination.clearCursorEpoch(),
      clear_cache: () => this.termination.clearCache(),
      delete_token: () => this.termination.deleteToken(),
    };
    for (let index = journal.checkpoint; index < AUTH_TERMINATION_STEPS.length; index++) {
      const step = AUTH_TERMINATION_STEPS[index];
      try {
        await effects[step]();
        journal = await this.checkpoint(journal, index + 1);
      } catch (error) {
        const failed = { ...journal, status: 'failed_fenced' as const, failure: { step, message: errorMessage(error) }, updatedAt: new Date().toISOString() };
        await this.store.write(failed);
        throw error;
      }
    }
    if (operation === 'delete_account' && this.termination.deleteRemoteAccount) {
      try {
        await this.termination.deleteRemoteAccount();
      } catch (error) {
        const failed = { ...journal, status: 'failed_fenced' as const, failure: { step: 'delete_remote_account', message: errorMessage(error) }, updatedAt: new Date().toISOString() };
        await this.store.write(failed);
        return failed;
      }
    }
    journal = { ...journal, status: 'committed', updatedAt: new Date().toISOString() };
    await this.store.write(journal);
    await this.store.clear();
    return journal;
  }

  private async checkpoint(journal: AuthLifecycleJournal, checkpoint: number): Promise<AuthLifecycleJournal> {
    const next = { ...journal, checkpoint, status: 'running' as const, failure: undefined, updatedAt: new Date().toISOString() };
    await this.store.write(next);
    return next;
  }
}

export function createStorageJournalStore(storage: {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}): AuthLifecycleJournalStore {
  return {
    async read() {
      const raw = await storage.getItem(AUTH_LIFECYCLE_JOURNAL_KEY);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as AuthLifecycleJournal;
        return parsed?.version === 1 ? parsed : null;
      } catch { return null; }
    },
    async write(journal) { await storage.setItem(AUTH_LIFECYCLE_JOURNAL_KEY, JSON.stringify(journal)); },
    async clear() { await storage.removeItem(AUTH_LIFECYCLE_JOURNAL_KEY); },
  };
}
