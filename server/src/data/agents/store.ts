import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentProfileRecord, AgentProfileInfo, AgentsFileData } from './types.js';

const DEFAULT_PROFILE: Omit<AgentProfileRecord, 'updatedAt' | 'updatedBy'> = {
  name: '开开',
  avatar: '🤖',
};

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

export class AgentStore {
  private agents: Record<string, AgentProfileRecord> = {};
  private filePath: string;
  private writeTail: Promise<void> = Promise.resolve();
  private sourceWasPresent = false;

  constructor(filePath: string) {
    this.filePath = filePath;
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

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const guarded = async (): Promise<T> => {
      const previous = structuredClone(this.agents);
      try {
        return await operation();
      } catch (error) {
        this.agents = previous;
        throw error;
      }
    };
    const run = this.writeTail.then(guarded, guarded);
    this.writeTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async persist(): Promise<void> {
    const data: AgentsFileData = { version: 1, agents: this.agents };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = join(dirname(this.filePath), `.agents.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    try {
      await rename(tmpPath, this.filePath);
      this.sourceWasPresent = true;
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      throw err;
    }
  }

  get(username: string): AgentProfileRecord | undefined {
    return this.agents[username];
  }

  getOrDefault(username: string): AgentProfileInfo {
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
    return Object.entries(this.agents).map(([username, profile]) => ({
      ...profile,
      username,
    }));
  }

  async set(username: string, partial: Partial<AgentProfileRecord>, updatedBy: string): Promise<AgentProfileInfo> {
    return this.enqueueWrite(async () => {
      this.load();
      const existing = this.agents[username];
      const now = new Date().toISOString();
      if (existing) Object.assign(existing, partial, { updatedAt: now, updatedBy });
      else this.agents[username] = { ...DEFAULT_PROFILE, ...partial, updatedAt: now, updatedBy };
      await this.persist();
      return { ...this.agents[username], username };
    });
  }

  async remove(username: string): Promise<void> {
    await this.enqueueWrite(async () => {
      this.load();
      if (!(username in this.agents)) return;
      delete this.agents[username];
      await this.persist();
    });
  }

  async removeMany(usernames: Iterable<string>): Promise<number> {
    const targets = [...usernames];
    return this.enqueueWrite(async () => {
      this.load();
      let removed = 0;
      for (const username of targets) {
        if (!(username in this.agents)) continue;
        delete this.agents[username];
        removed++;
      }
      if (removed > 0) await this.persist();
      return removed;
    });
  }

  /** 为不存在记录的用户写入默认 profile */
  initDefaults(usernames: string[]): void {
    this.load();
    const previous = structuredClone(this.agents);
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
      // 启动期也先写唯一临时文件再原子替换，禁止把中断写入暴露成合法空库。
      const data: AgentsFileData = { version: 1, agents: this.agents };
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmpPath = join(dirname(this.filePath), `.agents.${randomBytes(6).toString('hex')}.tmp`);
      try {
        writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
        renameSync(tmpPath, this.filePath);
        this.sourceWasPresent = true;
      } catch (error) {
        this.agents = previous;
        throw error;
      } finally {
        try {
          unlinkSync(tmpPath);
        } catch {
          /* already renamed or cleanup best effort */
        }
      }
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
