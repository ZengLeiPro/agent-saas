import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  PlatformSkillConfig,
  PlatformSkillExposure,
  SkillsConfigData,
  TenantSkillConfig,
  TenantSkillMemberExposure,
  TenantSkillRule,
  UserSkillConfig,
} from './types.js';

const DEFAULT_PLATFORM_EXPOSURE: PlatformSkillExposure = 'all';
const DEFAULT_TENANT_EXPOSURE: TenantSkillMemberExposure = 'all';

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
    this.data = { version: 1, configVersion: 0, poolVisibility: {}, platform: {}, tenants: {}, users: {} };
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
    const result: Record<string, boolean> = {};
    for (const id of new Set([
      ...Object.keys(this.data.poolVisibility),
      ...Object.keys(this.data.platform ?? {}),
    ])) {
      result[id] = this.getPlatformSkillConfig(id).enabled;
    }
    return result;
  }

  isPoolSkillVisible(skillId: string): boolean {
    return this.getPlatformSkillConfig(skillId).enabled;
  }

  getPlatformSkillConfig(skillId: string): PlatformSkillConfig {
    return this.normalizePlatformSkillConfig(skillId, this.data.platform?.[skillId]);
  }

  getPlatformSkillConfigs(): Record<string, PlatformSkillConfig> {
    const result: Record<string, PlatformSkillConfig> = {};
    for (const id of new Set([
      ...Object.keys(this.data.poolVisibility),
      ...Object.keys(this.data.platform ?? {}),
    ])) {
      result[id] = this.getPlatformSkillConfig(id);
    }
    return result;
  }

  getUserSelectedSkills(username: string): string[] {
    return this.data.users[username]?.selectedSkills ?? [];
  }

  isPoolSkillAvailableToTenant(skillId: string, tenantId: string | undefined): boolean {
    const config = this.getPlatformSkillConfig(skillId);
    if (!config.enabled) return false;
    if (!tenantId) return true;
    if (config.exposure === 'allow_tenants') return config.tenantIds.includes(tenantId);
    if (config.exposure === 'deny_tenants') return !config.tenantIds.includes(tenantId);
    return true;
  }

  /**
   * 租户启用集合：平台开放 ∩ 租户启用。
   * 未显式配置的租户默认启用当前平台开放 skill，兼容旧配置。
   */
  getTenantEnabledSkills(tenantId: string | undefined, visibleSkillIds?: string[]): string[] {
    const candidates = visibleSkillIds ?? Object.entries(this.getPoolVisibility())
      .filter(([, visible]) => visible)
      .map(([id]) => id);
    return candidates.filter((id) => {
      if (!this.isPoolSkillAvailableToTenant(id, tenantId)) return false;
      if (!tenantId) return true;
      return this.getTenantSkillRule(tenantId, id).enabled;
    });
  }

  getTenantSkillRule(tenantId: string | undefined, skillId: string): TenantSkillRule {
    if (!tenantId) return { enabled: true, exposure: DEFAULT_TENANT_EXPOSURE, usernames: [] };
    const tenant = this.data.tenants[tenantId];
    return this.normalizeTenantSkillRule(tenant, skillId, tenant?.skills?.[skillId]);
  }

  isTenantSkillAvailableToUser(skillId: string, tenantId: string | undefined, username: string | undefined): boolean {
    if (!this.isPoolSkillAvailableToTenant(skillId, tenantId)) return false;
    if (!tenantId) return true;
    const rule = this.getTenantSkillRule(tenantId, skillId);
    if (!rule.enabled) return false;
    if (rule.exposure === 'allow_users') return !!username && rule.usernames.includes(username);
    if (rule.exposure === 'deny_users') return !username || !rule.usernames.includes(username);
    return true;
  }

  /**
   * 计算用户的有效 pool skill 集合 = platformAllowed ∩ tenantRuleAllowed ∩ selectedSkills
   */
  getUserEffectivePoolSkills(username: string, tenantId?: string): string[] {
    const selected = this.getUserSelectedSkills(username);
    return selected.filter(id => this.isTenantSkillAvailableToUser(id, tenantId, username));
  }

  // ── 租户自有 skill（tenants/<tenantId>/skills/）────────

  /** 租户自有 skill 的治理规则；未配置默认 enabled + 全员开放 */
  getTenantOwnSkillRule(tenantId: string, skillId: string): TenantSkillRule {
    // tenant 参数传 undefined：own skill 不受旧 enabledSkills（pool 语义）影响，默认 enabled=true
    return this.normalizeTenantSkillRule(undefined, skillId, this.data.tenants[tenantId]?.ownSkills?.[skillId]);
  }

  getTenantOwnSkillRules(tenantId: string): Record<string, TenantSkillRule> {
    const result: Record<string, TenantSkillRule> = {};
    for (const id of Object.keys(this.data.tenants[tenantId]?.ownSkills ?? {})) {
      result[id] = this.getTenantOwnSkillRule(tenantId, id);
    }
    return result;
  }

  /** 自有 skill 对成员的可用性：仅租户规则（enabled + 成员范围），不经过平台层 */
  isTenantOwnSkillAvailableToUser(tenantId: string, skillId: string, username: string | undefined): boolean {
    const rule = this.getTenantOwnSkillRule(tenantId, skillId);
    if (!rule.enabled) return false;
    if (rule.exposure === 'allow_users') return !!username && rule.usernames.includes(username);
    if (rule.exposure === 'deny_users') return !username || !rule.usernames.includes(username);
    return true;
  }

  /** 用户的有效租户自有 skill = 目录现存 ∩ 租户规则允许 ∩ selectedSkills */
  getUserEffectiveTenantOwnSkills(username: string, tenantId: string | undefined, availableOwnIds: Set<string>): string[] {
    if (!tenantId) return [];
    return this.getUserSelectedSkills(username)
      .filter(id => availableOwnIds.has(id) && this.isTenantOwnSkillAvailableToUser(tenantId, id, username));
  }

  async setTenantOwnSkillRules(tenantId: string, updates: Record<string, TenantSkillRule>): Promise<void> {
    await this.serialize(async () => {
      const current = this.data.tenants[tenantId] ?? {};
      const rules = { ...(current.ownSkills ?? {}) };
      for (const [id, rule] of Object.entries(updates)) {
        rules[id] = this.normalizeTenantSkillRule(undefined, id, rule);
      }
      this.data.tenants[tenantId] = { ...current, ownSkills: rules };
      this.bumpVersion();
      await this.persist();
    });
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
        const current = this.getPlatformSkillConfig(id);
        this.ensurePlatformConfigMap()[id] = { ...current, enabled: visible };
      }
      this.bumpVersion();
      await this.persist();
    });
  }

  async setPlatformSkillConfigs(updates: Record<string, PlatformSkillConfig>): Promise<void> {
    await this.serialize(async () => {
      const platform = this.ensurePlatformConfigMap();
      for (const [id, config] of Object.entries(updates)) {
        const normalized = this.normalizePlatformSkillConfig(id, config);
        platform[id] = normalized;
        this.data.poolVisibility[id] = normalized.enabled;
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
      const current = this.data.tenants[tenantId] ?? {};
      const enabled = new Set(skills);
      const rules = current.skills
        ? Object.fromEntries(
          Object.entries(current.skills).map(([id, rule]) => [id, { ...rule, enabled: enabled.has(id) }]),
        )
        : undefined;
      this.data.tenants[tenantId] = { ...current, enabledSkills: skills, skills: rules };
      this.bumpVersion();
      await this.persist();
    });
  }

  async setTenantSkillRules(tenantId: string, updates: Record<string, TenantSkillRule>): Promise<void> {
    await this.serialize(async () => {
      const current = this.data.tenants[tenantId] ?? {};
      const rules = { ...(current.skills ?? {}) };
      for (const [id, rule] of Object.entries(updates)) {
        rules[id] = this.normalizeTenantSkillRule(current, id, rule);
      }
      this.data.tenants[tenantId] = { ...current, skills: rules };
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
    const platform: Record<string, PlatformSkillConfig> = {};
    for (const [id, enabled] of Object.entries(poolVisibility)) {
      platform[id] = { enabled, exposure: DEFAULT_PLATFORM_EXPOSURE, tenantIds: [] };
    }
    this.data = {
      version: 1,
      configVersion: 1,
      poolVisibility,
      platform,
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
    let changed = false;
    for (const id of currentPoolIds) {
      if (!(id in this.data.poolVisibility)) {
        this.data.poolVisibility[id] = true;
        added++;
        changed = true;
      }
      const platform = this.ensurePlatformConfigMap();
      if (!platform[id]) {
        platform[id] = this.getPlatformSkillConfig(id);
        changed = true;
      }
    }
    if (changed) {
      this.bumpVersion();
      this.persistSync();
    }
    return added;
  }

  /**
   * 清理幽灵条目：pool 中已不存在的 skill ID 从 poolVisibility 和所有用户的 selectedSkills 中移除。
   * 同步写入，启动时调用。返回被清理的 ID 数量。
   *
   * @param tenantOwnIdsByTenant 各租户自有 skill 目录的现存 ID；用于：
   *   1. 保留 selectedSkills 中的租户自有 skill（宽松并集：跨租户误保留仅是无害冗余，物化按本租户过滤）
   *   2. 清理 ownSkills 中目录已不存在的规则条目
   */
  pruneStaleSkills(currentPoolIds: Set<string>, tenantOwnIdsByTenant: Record<string, Set<string>> = {}): number {
    let pruned = 0;
    const anyOwnIds = new Set<string>();
    for (const ids of Object.values(tenantOwnIdsByTenant)) {
      for (const id of ids) anyOwnIds.add(id);
    }
    for (const id of Object.keys(this.data.poolVisibility)) {
      if (!currentPoolIds.has(id)) {
        delete this.data.poolVisibility[id];
        if (this.data.platform) delete this.data.platform[id];
        pruned++;
      }
    }
    if (this.data.platform) {
      for (const id of Object.keys(this.data.platform)) {
        if (!currentPoolIds.has(id)) {
          delete this.data.platform[id];
          pruned++;
        }
      }
    }
    for (const config of Object.values(this.data.users)) {
      const before = config.selectedSkills.length;
      config.selectedSkills = config.selectedSkills.filter(id => currentPoolIds.has(id) || anyOwnIds.has(id));
      pruned += before - config.selectedSkills.length;
    }
    for (const [tenantId, config] of Object.entries(this.data.tenants)) {
      const before = config.enabledSkills?.length ?? 0;
      config.enabledSkills = config.enabledSkills?.filter(id => currentPoolIds.has(id));
      pruned += before - (config.enabledSkills?.length ?? 0);
      if (config.skills) {
        for (const id of Object.keys(config.skills)) {
          if (!currentPoolIds.has(id)) {
            delete config.skills[id];
            pruned++;
          }
        }
      }
      if (config.ownSkills) {
        const ownIds = tenantOwnIdsByTenant[tenantId] ?? new Set<string>();
        for (const id of Object.keys(config.ownSkills)) {
          if (!ownIds.has(id)) {
            delete config.ownSkills[id];
            pruned++;
          }
        }
      }
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
        platform: parsed.platform ?? {},
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

  private ensurePlatformConfigMap(): Record<string, PlatformSkillConfig> {
    if (!this.data.platform) this.data.platform = {};
    return this.data.platform;
  }

  private normalizePlatformSkillConfig(skillId: string, config: PlatformSkillConfig | undefined): PlatformSkillConfig {
    const exposure = config?.exposure === 'allow_tenants' || config?.exposure === 'deny_tenants'
      ? config.exposure
      : DEFAULT_PLATFORM_EXPOSURE;
    return {
      enabled: config?.enabled ?? (this.data.poolVisibility[skillId] !== false),
      exposure,
      tenantIds: Array.from(new Set((config?.tenantIds ?? []).filter(Boolean))).sort(),
    };
  }

  private normalizeTenantSkillRule(
    tenant: TenantSkillConfig | undefined,
    skillId: string,
    rule: TenantSkillRule | undefined,
  ): TenantSkillRule {
    const exposure = rule?.exposure === 'allow_users' || rule?.exposure === 'deny_users'
      ? rule.exposure
      : DEFAULT_TENANT_EXPOSURE;
    const legacyEnabled = tenant?.enabledSkills
      ? tenant.enabledSkills.includes(skillId)
      : true;
    return {
      enabled: rule?.enabled ?? legacyEnabled,
      exposure,
      usernames: Array.from(new Set((rule?.usernames ?? []).filter(Boolean))).sort(),
    };
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
