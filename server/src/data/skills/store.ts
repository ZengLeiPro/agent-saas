import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SkillsConfigData, TenantSkillConfig, UserSkillConfig } from './types.js';

export class SkillConfigStore {
  private data: SkillsConfigData;
  private filePath: string;
  /** load() 时文件存在但解析失败，启动时应跳过全量 sync 避免以空数据执行破坏性操作 */
  loadFailed = false;
  /**
   * 串行 mutation 的尾部 promise（δ 阶段加锁）。所有 set/touch/remove 都 await
   * 上一次操作完成后再开始，避免 bumpVersion + persist 的非原子两段式被并发交叉，
   * 导致 configVersion 与磁盘脱钩、refreshUserWorkspace 触发全用户 syncSkills 风暴。
   */
  private mutationChain: Promise<unknown> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = { version: 1, configVersion: 0, poolVisibility: {}, tenants: {}, users: {} };
    this.load();
  }

  /** 把 mutation 串行化到 mutationChain；返回该 mutation 的 promise。 */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationChain.then(fn, fn);
    this.mutationChain = next.catch(() => undefined);
    return next;
  }

  // ── 读取 ───────────────────────────────────────────────

  getConfigVersion(): number {
    return this.data.configVersion;
  }

  getPoolVisibility(): Record<string, boolean> {
    return { ...this.data.poolVisibility };
  }

  isPoolSkillVisible(skillId: string): boolean {
    return this.data.poolVisibility[skillId] !== false;
  }

  getUserSelectedSkills(username: string): string[] {
    return this.data.users[username]?.selectedSkills ?? [];
  }

  /**
   * 租户启用集合：未显式配置的租户默认启用当前平台可见 skill，兼容旧配置。
   */
  getTenantEnabledSkills(tenantId: string | undefined, visibleSkillIds?: string[]): string[] {
    const fallback = visibleSkillIds ?? Object.entries(this.data.poolVisibility)
      .filter(([, visible]) => visible !== false)
      .map(([id]) => id);
    if (!tenantId) return fallback;
    return this.data.tenants[tenantId]?.enabledSkills ?? fallback;
  }

  /**
   * 计算用户的有效 pool skill 集合 = visible ∩ tenantEnabled ∩ selectedSkills
   */
  getUserEffectivePoolSkills(username: string, tenantId?: string): string[] {
    const selected = this.getUserSelectedSkills(username);
    const tenantEnabled = new Set(this.getTenantEnabledSkills(tenantId));
    return selected.filter(id => this.data.poolVisibility[id] !== false && tenantEnabled.has(id));
  }

  getAllUserConfigs(): Record<string, UserSkillConfig> {
    return { ...this.data.users };
  }

  getAllTenantConfigs(): Record<string, TenantSkillConfig> {
    return { ...this.data.tenants };
  }

  // ── 写入（每次 mutation configVersion++）──────────────

  async setPoolVisibility(updates: Record<string, boolean>): Promise<void> {
    await this.serialize(async () => {
      for (const [id, visible] of Object.entries(updates)) {
        this.data.poolVisibility[id] = visible;
      }
      this.bumpVersion();
      await this.persist();
    });
  }

  async setUserSelectedSkills(username: string, skills: string[]): Promise<void> {
    await this.serialize(async () => {
      if (!this.data.users[username]) {
        this.data.users[username] = { selectedSkills: [] };
      }
      this.data.users[username].selectedSkills = skills;
      this.bumpVersion();
      await this.persist();
    });
  }

  async setTenantEnabledSkills(tenantId: string, skills: string[]): Promise<void> {
    await this.serialize(async () => {
      this.data.tenants[tenantId] = { enabledSkills: skills };
      this.bumpVersion();
      await this.persist();
    });
  }

  /**
   * 从旧 manifest 数据初始化（首次迁移用）。
   * 同步写入，因为在服务启动阶段调用。
   */
  initializeFrom(
    poolVisibility: Record<string, boolean>,
    users: Record<string, UserSkillConfig>,
  ): void {
    this.data = {
      version: 1,
      configVersion: 1,
      poolVisibility,
      tenants: {},
      users,
    };
    this.persistSync();
  }

  async removeUser(username: string): Promise<void> {
    await this.serialize(async () => {
      if (!(username in this.data.users)) return;
      delete this.data.users[username];
      this.bumpVersion();
      await this.persist();
    });
  }

  /**
   * Pool skill 文件内容变更时，仅推进配置版本，驱动用户工作区下次按版本重新同步。
   * 用于 admin 在线编辑 pool 的 SKILL.md 内容后失效活跃会话的 skill 缓存。
   */
  async touchConfigVersion(): Promise<void> {
    await this.serialize(async () => {
      this.bumpVersion();
      await this.persist();
    });
  }

  /**
   * 将 pool 文件系统状态同步到 poolVisibility：补全缺失条目（默认 visible: true）。
   * 不覆盖已有条目（admin 手动设为 false 的不会被重置）。
   * 同步写入，启动时调用。返回新增数量。
   */
  syncWithPool(currentPoolIds: Set<string>): number {
    let added = 0;
    for (const id of currentPoolIds) {
      if (!(id in this.data.poolVisibility)) {
        this.data.poolVisibility[id] = true;
        added++;
      }
    }
    if (added > 0) {
      this.bumpVersion();
      this.persistSync();
    }
    return added;
  }

  /**
   * 清理幽灵条目：pool 中已不存在的 skill ID 从 poolVisibility 和所有用户的 selectedSkills 中移除。
   * 同步写入，启动时调用。返回被清理的 ID 数量。
   */
  pruneStaleSkills(currentPoolIds: Set<string>): number {
    let pruned = 0;
    for (const id of Object.keys(this.data.poolVisibility)) {
      if (!currentPoolIds.has(id)) {
        delete this.data.poolVisibility[id];
        pruned++;
      }
    }
    for (const config of Object.values(this.data.users)) {
      const before = config.selectedSkills.length;
      config.selectedSkills = config.selectedSkills.filter(id => currentPoolIds.has(id));
      pruned += before - config.selectedSkills.length;
    }
    for (const config of Object.values(this.data.tenants)) {
      const before = config.enabledSkills.length;
      config.enabledSkills = config.enabledSkills.filter(id => currentPoolIds.has(id));
      pruned += before - config.enabledSkills.length;
    }
    if (pruned > 0) {
      this.bumpVersion();
      this.persistSync();
    }
    return pruned;
  }

  // ── 内部 ───────────────────────────────────────────────

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as SkillsConfigData;
      this.data = {
        version: 1,
        configVersion: parsed.configVersion ?? 0,
        poolVisibility: parsed.poolVisibility ?? {},
        tenants: parsed.tenants ?? {},
        users: parsed.users ?? {},
      };
    } catch (err) {
      this.loadFailed = true;
      // ESM 环境使用 dynamic import 输出错误日志（异步但 loadFailed 已同步设置）
      import('../../utils/logger.js').then(
        ({ serverLogger }) => serverLogger.error(`Failed to parse skills config ${this.filePath}: ${err}`),
      ).catch(() => {});
    }
  }

  private bumpVersion(): void {
    this.data.configVersion++;
  }

  private async persist(): Promise<void> {
    if (this.loadFailed) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = join(dirname(this.filePath), `.skills-config.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(tmpPath, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    try {
      await rename(tmpPath, this.filePath);
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      throw err;
    }
  }

  private persistSync(): void {
    if (this.loadFailed) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }
}
