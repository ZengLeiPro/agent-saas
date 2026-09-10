import { randomBytes } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import { open, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import bcrypt from "bcrypt";
import type { UserPermissions } from "../../types/index.js";
import type { PlatformCapability, PlatformCapabilityLimits } from "../../../../shared/src/types/user.js";
import { DEFAULT_USER_PREFERENCES } from "./types.js";
import type { UserRecord, UserRole, UserInfo, UsersFileData, GroupSortingPref, UserPreferences } from "./types.js";
import { DEFAULT_TENANT_ID, LEGACY_TENANT_ID } from "../tenants/types.js";
import { authLogger } from "../../utils/logger.js";

const BCRYPT_ROUNDS = 10;
const USER_ID_PREFIX = "ky";
const USER_ID_RANDOM_LENGTH = 12;
const USER_ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const USER_ID_MAX_ATTEMPTS = 16;
const PHONE_PATTERN = /^1[3-9]\d{9}$/;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_RETRY_MS = 20;

export const USER_ID_PATTERN = /^ky[0-9abcdefghjkmnpqrstvwxyz]{12}$/;

export function generateUserId(): string {
  const bytes = randomBytes(USER_ID_RANDOM_LENGTH);
  let suffix = "";
  for (const byte of bytes) {
    suffix += USER_ID_ALPHABET[byte & 31];
  }
  return `${USER_ID_PREFIX}${suffix}`;
}

export interface CreateUserInput {
  username: string;
  password: string;
  role: UserRole;
  createdBy: string;
  realName?: string;
  /** 岗位（自由文本，路由层校验长度） */
  position?: string;
  /** 手机号（自助注册链路创建时写入；路由层负责格式校验与查重） */
  phone?: string;
  /** 手机号验证时间；短信注册链路通过验证码后写入。 */
  phoneVerifiedAt?: string;
  dingtalkStaffId?: string;
  debugMode?: boolean;
  /** Tenant 归属。所有调用方都必须显式传入，不允许静默落入平台根组织。 */
  tenantId: string;
  permissions?: UserPermissions;
  platformCapabilities?: PlatformCapability[];
  platformCapabilityLimits?: PlatformCapabilityLimits;
  preferences?: UserPreferences;
}

export interface UpdateUserInput {
  password?: string;
  role?: UserRole;
  realName?: string;
  /** 岗位：空字符串 = 清除；非空 = 设置。 */
  position?: string;
  /** 手机号：空字符串 = 清除；非空 = 设置（路由层负责格式校验）。 */
  phone?: string;
  /** 手机号验证时间；传空字符串清除。 */
  phoneVerifiedAt?: string;
  avatar?: string;
  dingtalkStaffId?: string;
  debugMode?: boolean;
  /** B1: 设为非空字符串 = 设置；设为空字符串 = 清除归属。 */
  tenantId?: string;
  permissions?: UserPermissions;
  platformCapabilities?: PlatformCapability[];
  platformCapabilityLimits?: PlatformCapabilityLimits;
  preferences?: UserPreferences;
}

export interface UserStoreOptions {
  /** 生产环境可注入 PG advisory lock；本地使用同路径的 create-only 文件锁。 */
  withLock?: <T>(operation: () => Promise<T>) => Promise<T>;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
}

interface LocalLock {
  handle: Awaited<ReturnType<typeof open>>;
  token: string;
}

interface MutationResult<T> {
  changed: boolean;
  value: T;
}

export class UserStoreUnavailableError extends Error {
  readonly code = "USER_STORE_UNAVAILABLE";

  constructor(filePath: string, cause: unknown) {
    super(`Failed to read users store: ${filePath}`, { cause });
    this.name = "UserStoreUnavailableError";
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class UserStore {
  private users: UserRecord[] = [];
  private filePath: string;
  private debugModeMigrationVersion: 1 = 1;
  private postPersistObserver?: () => void;
  private readonly options: UserStoreOptions;
  private mutationQueue: Promise<void> = Promise.resolve();
  private sourceWasPresent = false;

  constructor(filePath: string, options: UserStoreOptions = {}) {
    this.filePath = filePath;
    this.options = options;
    const migrated = this.load();
    if (migrated) {
      void this.mutate(() => ({ changed: false, value: undefined })).catch((error) => {
        authLogger.warn(`Failed to persist user record migrations: ${error}`);
      });
    }
  }

  /** 返回本次读取是否应用了需要持久化的兼容迁移。 */
  private load(): boolean {
    let needsDebugModeMigration = false;
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const data: UsersFileData = JSON.parse(raw);
      if (data.version !== 1 || !Array.isArray(data.users)) {
        throw new Error("Invalid users store structure");
      }
      for (const user of data.users) {
        if (
          !user ||
          typeof user !== "object" ||
          typeof user.id !== "string" ||
          typeof user.username !== "string" ||
          typeof user.passwordHash !== "string" ||
          (user.role !== "admin" && user.role !== "user")
        ) {
          throw new Error("Invalid user record");
        }
      }
      this.users = data.users;
      this.sourceWasPresent = true;
      needsDebugModeMigration = data.debugModeMigrationVersion !== 1;
    } catch (error) {
      if (errorCode(error) === "ENOENT" && !this.sourceWasPresent) {
        mkdirSync(dirname(this.filePath), { recursive: true });
        this.users = [];
        this.debugModeMigrationVersion = 1;
        return false;
      }
      throw new UserStoreUnavailableError(this.filePath, error);
    }

    // PR 2 迁移：为缺失 tenantId 的旧记录回填。
    // admin 代表平台最高权限，回填平台根组织；其他旧用户沿历史口径回填开沿日常组织。
    // 一次性持久化由 constructor 排入受锁 mutation；失败不阻止启动，下次启动会再次回填。
    let migrated = 0;
    let purgedMediaSync = 0;
    let purgedLegacyDebugMode = 0;
    for (const u of this.users as Array<UserRecord & { photoSync?: unknown }>) {
      if (needsDebugModeMigration && u.debugMode === true) {
        u.debugMode = false;
        purgedLegacyDebugMode += 1;
      }
      if ("photoSync" in u) {
        delete u.photoSync;
        purgedMediaSync += 1;
      }
      if (!u.tenantId) {
        u.tenantId = u.username === "admin" && u.role === "admin" ? DEFAULT_TENANT_ID : LEGACY_TENANT_ID;
        migrated += 1;
      }
    }
    this.debugModeMigrationVersion = 1;
    const changed = needsDebugModeMigration || migrated > 0 || purgedMediaSync > 0;
    if (changed) {
      if (needsDebugModeMigration) {
        authLogger.info(`Purged ${purgedLegacyDebugMode} legacy debug mode value(s) from user records`);
      }
      if (migrated > 0) {
        authLogger.info(`Migrated ${migrated} legacy user record(s) to tenantId by platform/admin split`);
      }
      if (purgedMediaSync > 0) {
        authLogger.info(`Purged ${purgedMediaSync} legacy photo sync setting(s) from user records`);
      }
    }
    return changed;
  }

  /** 重新读取共享 users.json，供多进程后台执行器刷新用户状态。 */
  reload(): void {
    this.load();
  }

  setPostPersistObserver(observer: (() => void) | undefined): void {
    this.postPersistObserver = observer;
  }

  private async persist(): Promise<void> {
    const data: UsersFileData = {
      version: 1,
      debugModeMigrationVersion: this.debugModeMigrationVersion,
      users: this.users,
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = join(dirname(this.filePath), `.users.${randomBytes(6).toString("hex")}.tmp`);
    await writeFile(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    try {
      await rename(tmpPath, this.filePath);
      this.sourceWasPresent = true;
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      throw err;
    }
    try {
      this.postPersistObserver?.();
    } catch (error) {
      authLogger.warn(`User post-persist observer failed: ${error}`);
    }
  }

  private async acquireLocalLock(): Promise<LocalLock> {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const lockPath = `${this.filePath}.lock`;
    const timeoutMs = Math.max(0, this.options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
    const retryMs = Math.max(1, this.options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS);
    const deadline = Date.now() + timeoutMs;
    const token = randomBytes(16).toString("hex");
    for (;;) {
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(lockPath, "wx", 0o600);
        await handle.writeFile(token, "utf-8");
        return { handle, token };
      } catch (error) {
        await handle?.close().catch(() => undefined);
        if (handle) await unlink(lockPath).catch(() => undefined);
        if (errorCode(error) !== "EEXIST") throw error;
        if (Date.now() >= deadline) {
          throw new Error(`Timed out acquiring users store lock: ${lockPath}`);
        }
        await sleep(Math.min(retryMs, Math.max(1, deadline - Date.now())));
      }
    }
  }

  private async releaseLocalLock(lock: LocalLock): Promise<void> {
    const lockPath = `${this.filePath}.lock`;
    await lock.handle.close().catch(() => undefined);
    try {
      if ((await readFile(lockPath, "utf-8")) === lock.token) await unlink(lockPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }

  private async mutate<T>(operation: () => MutationResult<T> | Promise<MutationResult<T>>): Promise<T> {
    const execute = async (): Promise<T> => {
      const previousUsers = this.users;
      const previousMigrationVersion = this.debugModeMigrationVersion;
      let committedUsers = previousUsers;
      let committedMigrationVersion = previousMigrationVersion;
      try {
        const migrated = this.load();
        committedUsers = structuredClone(this.users);
        committedMigrationVersion = this.debugModeMigrationVersion;
        const result = await operation();
        if (migrated || result.changed) await this.persist();
        return result.value;
      } catch (error) {
        // If the locked reload succeeded, retain that last committed snapshot.
        // This prevents a conflict in one process from reviving its older view.
        this.users = committedUsers;
        this.debugModeMigrationVersion = committedMigrationVersion;
        throw error;
      }
    };
    const run = async (): Promise<T> => {
      if (this.options.withLock) return this.options.withLock(execute);
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

  findById(id: string): UserRecord | undefined {
    return this.users.find((u) => u.id === id);
  }

  findByUsername(username: string): UserRecord | undefined {
    const lower = username.toLowerCase();
    return this.users.find((u) => u.username.toLowerCase() === lower);
  }

  findAllByPhone(phone: string): UserRecord[] {
    if (!PHONE_PATTERN.test(phone)) return [];
    return this.users.filter((u) => u.phone === phone || u.username === phone);
  }

  findByPhone(phone: string): UserRecord | undefined {
    return this.findAllByPhone(phone)[0];
  }

  private findPhoneOwner(phone: string, excludeUserId?: string): UserRecord | undefined {
    if (!PHONE_PATTERN.test(phone)) return undefined;
    return this.users.find((u) => u.id !== excludeUserId && (u.phone === phone || u.username === phone));
  }

  findByDingtalkStaffId(staffId: string): UserRecord | undefined {
    return this.users.find((u) => u.dingtalkStaffId === staffId);
  }

  listAll(): UserInfo[] {
    return this.users.map(({ passwordHash, ...rest }) => {
      const safe = { ...rest } as typeof rest & { photoSync?: unknown };
      delete safe.photoSync;
      return safe;
    });
  }

  count(): number {
    return this.users.length;
  }

  async disableDebugModeForTenant(tenantId: string): Promise<number> {
    return this.mutate(() => {
      const now = new Date().toISOString();
      let changed = 0;
      for (const user of this.users) {
        if (user.tenantId !== tenantId || user.debugMode === false) continue;
        user.debugMode = false;
        user.updatedAt = now;
        changed += 1;
      }
      return { changed: changed > 0, value: changed };
    });
  }

  adminCount(tenantId?: string): number {
    return this.users.filter((u) => u.role === "admin" && (!tenantId || u.tenantId === tenantId)).length;
  }

  activeAdminCount(tenantId?: string): number {
    return this.users.filter((u) => u.role === "admin" && !u.disabled && (!tenantId || u.tenantId === tenantId)).length;
  }

  async setDisabled(id: string, disabled: boolean, operatorId: string): Promise<UserInfo> {
    return this.mutate(() => {
      const user = this.findById(id);
      if (!user) throw new Error("User not found");
      if (id === operatorId) throw new Error("Cannot disable yourself");
      if (disabled && user.role === "admin" && this.activeAdminCount(user.tenantId) <= 1) {
        throw new Error("Cannot disable the last active admin");
      }
      user.disabled = disabled || undefined;
      user.disabledAt = disabled ? new Date().toISOString() : undefined;
      user.disabledBy = disabled ? operatorId : undefined;
      user.updatedAt = new Date().toISOString();
      const { passwordHash, ...info } = user;
      return { changed: true, value: info };
    });
  }

  async create(input: CreateUserInput): Promise<UserInfo> {
    if (!input.tenantId) {
      throw new Error("tenantId is required");
    }
    if (input.tenantId === DEFAULT_TENANT_ID && input.role !== "admin") {
      throw new Error(`Only platform admins may belong to tenant "${DEFAULT_TENANT_ID}"`);
    }
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    return this.mutate(() => {
      if (this.findByUsername(input.username)) throw new Error("Username already exists");
      if (this.findPhoneOwner(input.username)) throw new Error("Phone already exists");
      if (input.phone && this.findPhoneOwner(input.phone)) throw new Error("Phone already exists");
      const now = new Date().toISOString();
      const record: UserRecord = {
        id: this.generateUniqueUserId(),
        username: input.username,
        passwordHash,
        role: input.role,
        tenantId: input.tenantId,
        ...(input.realName ? { realName: input.realName } : {}),
        ...(input.position ? { position: input.position } : {}),
        ...(input.phone ? { phone: input.phone } : {}),
        ...(input.phone && input.phoneVerifiedAt ? { phoneVerifiedAt: input.phoneVerifiedAt } : {}),
        ...(input.dingtalkStaffId ? { dingtalkStaffId: input.dingtalkStaffId } : {}),
        debugMode: input.debugMode === true,
        ...(input.permissions ? { permissions: input.permissions } : {}),
        ...(input.platformCapabilities !== undefined ? { platformCapabilities: [...input.platformCapabilities] } : {}),
        ...(input.platformCapabilityLimits !== undefined
          ? { platformCapabilityLimits: { ...input.platformCapabilityLimits } }
          : {}),
        preferences: { ...DEFAULT_USER_PREFERENCES, ...(input.preferences ?? {}) },
        createdAt: now,
        createdBy: input.createdBy,
        updatedAt: now,
      };
      this.users.push(record);
      const { passwordHash: _passwordHash, ...info } = record;
      return { changed: true, value: info };
    });
  }

  private generateUniqueUserId(): string {
    for (let attempt = 0; attempt < USER_ID_MAX_ATTEMPTS; attempt += 1) {
      const id = generateUserId();
      if (!this.findById(id)) return id;
    }
    throw new Error("Failed to generate unique user id");
  }

  async update(id: string, input: UpdateUserInput): Promise<UserInfo> {
    const nextPasswordHash = input.password ? await bcrypt.hash(input.password, BCRYPT_ROUNDS) : undefined;
    return this.mutate(() => {
      const user = this.findById(id);
      if (!user) throw new Error("User not found");

      const nextRole = input.role ?? user.role;
      const nextTenantId = input.tenantId || user.tenantId;
      if (nextTenantId === DEFAULT_TENANT_ID && nextRole !== "admin") {
        throw new Error(`Only platform admins may belong to tenant "${DEFAULT_TENANT_ID}"`);
      }
      const removesActiveAdminFromTenant =
        user.role === "admin" && !user.disabled && (nextRole !== "admin" || nextTenantId !== user.tenantId);

      if (removesActiveAdminFromTenant && this.activeAdminCount(user.tenantId) <= 1) {
        throw new Error("Cannot change role of the last admin");
      }

      if (nextPasswordHash) user.passwordHash = nextPasswordHash;
      if (input.role) {
        user.role = input.role;
      }
      if (input.realName !== undefined) {
        user.realName = input.realName || undefined;
      }
      if (input.position !== undefined) {
        user.position = input.position || undefined;
      }
      if (input.phone !== undefined) {
        if (input.phone && this.findPhoneOwner(input.phone, user.id)) {
          throw new Error("Phone already exists");
        }
        user.phone = input.phone || undefined;
        user.phoneVerifiedAt = undefined;
      }
      if (input.phoneVerifiedAt !== undefined) {
        user.phoneVerifiedAt = input.phoneVerifiedAt || undefined;
      }
      if (input.avatar !== undefined) {
        user.avatar = input.avatar || undefined;
        user.avatarVersion = input.avatar ? Date.now() : undefined;
      }
      if (input.dingtalkStaffId !== undefined) {
        user.dingtalkStaffId = input.dingtalkStaffId || undefined;
      }
      if (input.debugMode !== undefined) {
        user.debugMode = input.debugMode === true;
      }
      if (input.tenantId !== undefined) {
        // PR 2 起 tenantId 必选——空字符串/undefined 都视为"不变更"
        if (input.tenantId) user.tenantId = input.tenantId;
      }
      if (input.permissions !== undefined) {
        user.permissions = input.permissions;
      }
      if (input.platformCapabilities !== undefined) {
        user.platformCapabilities = [...input.platformCapabilities];
      }
      if (input.platformCapabilityLimits !== undefined) {
        user.platformCapabilityLimits = { ...input.platformCapabilityLimits };
      }
      if (input.preferences !== undefined) {
        user.preferences = { ...(user.preferences ?? {}), ...input.preferences };
      }
      user.updatedAt = new Date().toISOString();
      const { passwordHash: _passwordHash, ...info } = user;
      return { changed: true, value: info };
    });
  }

  assertCanDelete(id: string): void {
    const user = this.findById(id);
    if (!user) throw new Error("User not found");
    if (user.role === "admin" && !user.disabled && this.activeAdminCount(user.tenantId) <= 1) {
      throw new Error("Cannot delete the last admin");
    }
  }

  async delete(id: string): Promise<void> {
    await this.mutate(() => {
      this.assertCanDelete(id);
      this.users = this.users.filter((u) => u.id !== id);
      return { changed: true, value: undefined };
    });
  }

  async deleteByTenant(tenantId: string): Promise<number> {
    return this.mutate(() => {
      const before = this.users.length;
      this.users = this.users.filter((u) => u.tenantId !== tenantId);
      const deleted = before - this.users.length;
      return { changed: deleted > 0, value: deleted };
    });
  }

  async verifyPassword(username: string, password: string): Promise<UserRecord | null> {
    const user = this.findByUsername(username);
    if (!user) return null;
    const valid = await bcrypt.compare(password, user.passwordHash);
    return valid ? user : null;
  }

  /**
   * 更新分组排序偏好。order 由调用方在路由层清洗（剔除不存在的 id、追加缺失的 id）。
   */
  async updateGroupSorting(userId: string, sorting: GroupSortingPref): Promise<UserInfo> {
    return this.mutate(() => {
      const user = this.findById(userId);
      if (!user) throw new Error("User not found");
      user.groupSorting = sorting;
      user.updatedAt = new Date().toISOString();
      const { passwordHash, ...info } = user;
      return { changed: true, value: info };
    });
  }

  /** 更新用户偏好。 */
  async updatePreferences(userId: string, preferences: UserPreferences): Promise<UserInfo> {
    return this.mutate(() => {
      const user = this.findById(userId);
      if (!user) throw new Error("User not found");
      user.preferences = { ...(user.preferences ?? {}), ...preferences };
      user.updatedAt = new Date().toISOString();
      const { passwordHash, ...info } = user;
      return { changed: true, value: info };
    });
  }

  /** 更新用户的 app 版本号（由 activity 上报时调用） */
  async updateAppVersion(userId: string, version: string): Promise<void> {
    await this.mutate(() => {
      const user = this.findById(userId);
      if (!user) return { changed: false, value: undefined };
      user.appVersion = version;
      user.appVersionUpdatedAt = new Date().toISOString();
      return { changed: true, value: undefined };
    });
  }

  async resetPassword(userId: string, newPassword: string): Promise<void> {
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await this.mutate(() => {
      const user = this.findById(userId);
      if (!user) throw new Error("User not found");
      user.passwordHash = passwordHash;
      user.updatedAt = new Date().toISOString();
      return { changed: true, value: undefined };
    });
  }

  async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<boolean> {
    const user = this.findById(userId);
    if (!user) return false;
    const expectedHash = user.passwordHash;
    const valid = await bcrypt.compare(oldPassword, user.passwordHash);
    if (!valid) return false;
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    return this.mutate(() => {
      const current = this.findById(userId);
      if (!current || current.passwordHash !== expectedHash) {
        return { changed: false, value: false };
      }
      current.passwordHash = passwordHash;
      current.updatedAt = new Date().toISOString();
      return { changed: true, value: true };
    });
  }
}
