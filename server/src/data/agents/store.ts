import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { open, readFile, writeFile, rename, rm, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentProfileRecord, AgentProfileInfo, AgentsFileData } from './types.js';

const DEFAULT_PROFILE: Omit<AgentProfileRecord, 'updatedAt' | 'updatedBy'> = {
  name: '开开',
  avatar: '🤖',
};

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_RETRY_MS = 20;

export interface AgentStoreOptions {
  lockTimeoutMs?: number;
  lockRetryMs?: number;
}

interface LocalLock {
  handle: Awaited<ReturnType<typeof open>>;
  token: string;
}

interface LocalLockSync {
  fd: number;
  token: string;
}

interface MutationResult<T> {
  changed: boolean;
  value: T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

export class AgentStore {
  private agents: Record<string, AgentProfileRecord> = {};
  private readonly filePath: string;
  private readonly options: AgentStoreOptions;
  private mutationQueue: Promise<void> = Promise.resolve();
  private mutationActive = false;
  private sourceWasPresent = false;

  constructor(filePath: string, options: AgentStoreOptions = {}) {
    this.filePath = filePath;
    this.options = options;
    this.load();
  }

  private load(): void {
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const data: AgentsFileData = JSON.parse(raw);
      if (data.version !== 1 || !data.agents || typeof data.agents !== 'object' || Array.isArray(data.agents)) {
        throw new Error('Invalid agents store structure');
      }
      for (const [username, profile] of Object.entries(data.agents)) {
        if (
          !username ||
          !profile ||
          typeof profile !== 'object' ||
          typeof profile.name !== 'string' ||
          typeof profile.updatedAt !== 'string' ||
          typeof profile.updatedBy !== 'string'
        ) {
          throw new Error('Invalid agent profile record');
        }
      }
      this.agents = data.agents;
      this.sourceWasPresent = true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT' && !this.sourceWasPresent) {
        mkdirSync(dirname(this.filePath), { recursive: true });
        this.agents = {};
        return;
      }
      throw new AgentStoreUnavailableError(this.filePath, error);
    }
  }

  private refreshForRead(): void {
    if (!this.mutationActive) this.load();
  }

  private async acquireLocalLock(): Promise<LocalLock> {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const lockPath = `${this.filePath}.lock`;
    const timeoutMs = Math.max(0, this.options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
    const retryMs = Math.max(1, this.options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS);
    const deadline = Date.now() + timeoutMs;
    const token = randomUUID();
    for (;;) {
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(lockPath, 'wx', 0o600);
        await handle.writeFile(token, 'utf8');
        return { handle, token };
      } catch (error) {
        await handle?.close().catch(() => undefined);
        if (handle) await unlink(lockPath).catch(() => undefined);
        if (errorCode(error) !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw new Error(`Timed out acquiring agents store lock: ${lockPath}`);
        await sleep(Math.min(retryMs, Math.max(1, deadline - Date.now())));
      }
    }
  }

  private async releaseLocalLock(lock: LocalLock): Promise<void> {
    const lockPath = `${this.filePath}.lock`;
    await lock.handle.close().catch(() => undefined);
    try {
      if ((await readFile(lockPath, 'utf8')) === lock.token) await unlink(lockPath);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }

  private acquireLocalLockSync(): LocalLockSync {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const lockPath = `${this.filePath}.lock`;
    const timeoutMs = Math.max(0, this.options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
    const retryMs = Math.max(1, this.options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS);
    const deadline = Date.now() + timeoutMs;
    const token = randomUUID();
    const signal = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
      let fd: number | undefined;
      try {
        fd = openSync(lockPath, 'wx', 0o600);
        writeFileSync(fd, token, 'utf8');
        return { fd, token };
      } catch (error) {
        if (fd !== undefined) {
          try { closeSync(fd); } catch { /* best effort */ }
          try { unlinkSync(lockPath); } catch { /* best effort */ }
        }
        if (errorCode(error) !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw new Error(`Timed out acquiring agents store lock: ${lockPath}`);
        Atomics.wait(signal, 0, 0, Math.min(retryMs, Math.max(1, deadline - Date.now())));
      }
    }
  }

  private releaseLocalLockSync(lock: LocalLockSync): void {
    const lockPath = `${this.filePath}.lock`;
    try { closeSync(lock.fd); } catch { /* best effort */ }
    try {
      if (readFileSync(lockPath, 'utf8') === lock.token) unlinkSync(lockPath);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }

  private async mutate<T>(operation: () => MutationResult<T> | Promise<MutationResult<T>>): Promise<T> {
    const execute = async (): Promise<T> => {
      this.mutationActive = true;
      let committedAgents = this.agents;
      try {
        this.load();
        committedAgents = structuredClone(this.agents);
        const result = await operation();
        if (result.changed) await this.persist();
        return result.value;
      } catch (error) {
        this.agents = committedAgents;
        throw error;
      } finally {
        this.mutationActive = false;
      }
    };
    const run = async (): Promise<T> => {
      const lock = await this.acquireLocalLock();
      try {
        return await execute();
      } finally {
        await this.releaseLocalLock(lock);
      }
    };
    const queued = this.mutationQueue.then(run, run);
    this.mutationQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private async persist(): Promise<void> {
    const data: AgentsFileData = { version: 1, agents: this.agents };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = join(dirname(this.filePath), `.agents.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await writeFile(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
      await rename(tmpPath, this.filePath);
      this.sourceWasPresent = true;
    } finally {
      await rm(tmpPath, { force: true }).catch(() => undefined);
    }
  }

  get(username: string): AgentProfileRecord | undefined {
    this.refreshForRead();
    return this.agents[username];
  }

  getOrDefault(username: string): AgentProfileInfo {
    this.refreshForRead();
    return {
      ...(this.agents[username] ?? {
        ...DEFAULT_PROFILE,
        updatedAt: '',
        updatedBy: 'system',
      }),
      username,
    };
  }

  getAll(): AgentProfileInfo[] {
    this.refreshForRead();
    return Object.entries(this.agents).map(([username, profile]) => ({
      ...profile,
      username,
    }));
  }

  async set(username: string, partial: Partial<AgentProfileRecord>, updatedBy: string): Promise<AgentProfileInfo> {
    return this.mutate(() => {
      const existing = this.agents[username];
      const now = new Date().toISOString();
      if (existing) Object.assign(existing, partial, { updatedAt: now, updatedBy });
      else this.agents[username] = { ...DEFAULT_PROFILE, ...partial, updatedAt: now, updatedBy };
      return { changed: true, value: { ...this.agents[username], username } };
    });
  }

  async remove(username: string): Promise<void> {
    await this.mutate(() => {
      if (!(username in this.agents)) return { changed: false, value: undefined };
      delete this.agents[username];
      return { changed: true, value: undefined };
    });
  }

  async removeMany(usernames: Iterable<string>): Promise<number> {
    const targets = [...usernames];
    return this.mutate(() => {
      let removed = 0;
      for (const username of targets) {
        if (!(username in this.agents)) continue;
        delete this.agents[username];
        removed++;
      }
      return { changed: removed > 0, value: removed };
    });
  }

  /** 为不存在记录的用户写入默认 profile */
  initDefaults(usernames: string[]): void {
    if (this.mutationActive) throw new Error('Cannot initialize AgentStore defaults during a mutation');
    const lock = this.acquireLocalLockSync();
    this.mutationActive = true;
    let committedAgents = this.agents;
    try {
      this.load();
      committedAgents = structuredClone(this.agents);
      let changed = false;
      const now = new Date().toISOString();
      for (const username of usernames) {
        if (!(username in this.agents)) {
          this.agents[username] = {
            ...DEFAULT_PROFILE,
            updatedAt: now,
            updatedBy: 'system',
          };
          changed = true;
        }
      }
      if (changed) {
        const data: AgentsFileData = { version: 1, agents: this.agents };
        mkdirSync(dirname(this.filePath), { recursive: true });
        const tmpPath = join(dirname(this.filePath), `.agents.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
        try {
          writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
          renameSync(tmpPath, this.filePath);
          this.sourceWasPresent = true;
        } finally {
          try { unlinkSync(tmpPath); } catch { /* already renamed or best effort */ }
        }
      }
    } catch (error) {
      this.agents = committedAgents;
      throw error;
    } finally {
      this.mutationActive = false;
      this.releaseLocalLockSync(lock);
    }
  }
}

export class AgentStoreUnavailableError extends Error {
  readonly code = 'AGENT_STORE_UNAVAILABLE';

  constructor(filePath: string, cause: unknown) {
    super(`Failed to read agents store: ${filePath}`, { cause });
    this.name = 'AgentStoreUnavailableError';
  }
}
