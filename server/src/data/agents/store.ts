import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentProfileRecord, AgentProfileInfo, AgentsFileData } from './types.js';

const DEFAULT_PROFILE: Omit<AgentProfileRecord, 'updatedAt' | 'updatedBy'> = {
  name: '开开',
  avatar: '🤖',
};

export class AgentStore {
  private agents: Record<string, AgentProfileRecord> = {};
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) {
      mkdirSync(dirname(this.filePath), { recursive: true });
      this.agents = {};
      return;
    }
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const data: AgentsFileData = JSON.parse(raw);
      this.agents = data.agents || {};
    } catch {
      this.agents = {};
    }
  }

  private async persist(): Promise<void> {
    const data: AgentsFileData = { version: 1, agents: this.agents };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = join(dirname(this.filePath), `.agents.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    try {
      await rename(tmpPath, this.filePath);
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

  async set(
    username: string,
    partial: Partial<AgentProfileRecord>,
    updatedBy: string,
  ): Promise<AgentProfileInfo> {
    const existing = this.agents[username];
    const now = new Date().toISOString();

    if (existing) {
      Object.assign(existing, partial, { updatedAt: now, updatedBy });
    } else {
      this.agents[username] = {
        ...DEFAULT_PROFILE,
        ...partial,
        updatedAt: now,
        updatedBy,
      };
    }

    await this.persist();
    return { ...this.agents[username], username };
  }

  async remove(username: string): Promise<void> {
    if (!(username in this.agents)) return;
    delete this.agents[username];
    await this.persist();
  }

  /** 为不存在记录的用户写入默认 profile */
  initDefaults(usernames: string[]): void {
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
      // 同步写入（启动时一次性）
      const data: AgentsFileData = { version: 1, agents: this.agents };
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
    }
  }
}
