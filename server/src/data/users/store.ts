import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { writeFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import bcrypt from "bcrypt";
import type { UserPermissions } from "../../types/index.js";
import { DEFAULT_USER_PREFERENCES } from "./types.js";
import type {
  UserRecord,
  UserRole,
  UserInfo,
  UsersFileData,
  GroupSortingPref,
  UserPreferences,
} from "./types.js";
import { DEFAULT_TENANT_ID, LEGACY_TENANT_ID } from "../tenants/types.js";
import { authLogger } from "../../utils/logger.js";

const BCRYPT_ROUNDS = 10;
const USER_ID_PREFIX = "ky";
const USER_ID_RANDOM_LENGTH = 12;
const USER_ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const USER_ID_MAX_ATTEMPTS = 16;

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
  dingtalkStaffId?: string;
  debugMode?: boolean;
  /**
   * Tenant 归属。多组织改造 PR 2 起：未指定时默认归属平台根组织。
   * 调用方（routes/auth.ts POST /users）负责按 platform_admin / tenant_admin 语义
   * 校验 tenantId 合法性；store 层只保证字段存在。
   */
  tenantId?: string;
  permissions?: UserPermissions;
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
  avatar?: string;
  dingtalkStaffId?: string;
  debugMode?: boolean;
  /** B1: 设为非空字符串 = 设置；设为空字符串 = 清除归属。 */
  tenantId?: string;
  permissions?: UserPermissions;
  preferences?: UserPreferences;
}

export class UserStore {
  private users: UserRecord[] = [];
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) {
      mkdirSync(dirname(this.filePath), { recursive: true });
      this.users = [];
      return;
    }
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const data: UsersFileData = JSON.parse(raw);
      this.users = data.users || [];
    } catch {
      this.users = [];
      return;
    }

    // PR 2 迁移：为缺失 tenantId 的旧记录回填。
    // admin 代表平台最高权限，回填平台根组织；其他旧用户沿历史口径回填开沿日常组织。
    // 一次性持久化（fire-and-forget）。持久化失败不阻止启动——下次启动会再次回填。
    let migrated = 0;
    let purgedMediaSync = 0;
    for (const u of this.users as Array<UserRecord & { photoSync?: unknown }>) {
      if ("photoSync" in u) {
        delete u.photoSync;
        purgedMediaSync += 1;
      }
      if (!u.tenantId) {
        u.tenantId = u.username === "admin" && u.role === "admin" ? DEFAULT_TENANT_ID : LEGACY_TENANT_ID;
        migrated += 1;
      }
    }
    if (migrated > 0 || purgedMediaSync > 0) {
      if (migrated > 0) {
        authLogger.info(
          `Migrated ${migrated} legacy user record(s) to tenantId by platform/admin split`,
        );
      }
      if (purgedMediaSync > 0) {
        authLogger.info(
          `Purged ${purgedMediaSync} legacy photo sync setting(s) from user records`,
        );
      }
      void this.persist().catch((err) => {
        authLogger.warn(`Failed to persist tenantId migration: ${err}`);
      });
    }
  }

  private async persist(): Promise<void> {
    const data: UsersFileData = { version: 1, users: this.users };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = join(
      dirname(this.filePath),
      `.users.${randomBytes(6).toString("hex")}.tmp`,
    );
    await writeFile(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    try {
      await rename(tmpPath, this.filePath);
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      throw err;
    }
  }

  findById(id: string): UserRecord | undefined {
    return this.users.find((u) => u.id === id);
  }

  findByUsername(username: string): UserRecord | undefined {
    const lower = username.toLowerCase();
    return this.users.find((u) => u.username.toLowerCase() === lower);
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

  adminCount(tenantId?: string): number {
    return this.users.filter(
      (u) => u.role === "admin" && (!tenantId || u.tenantId === tenantId),
    ).length;
  }

  activeAdminCount(tenantId?: string): number {
    return this.users.filter(
      (u) =>
        u.role === "admin" &&
        !u.disabled &&
        (!tenantId || u.tenantId === tenantId),
    ).length;
  }

  async setDisabled(
    id: string,
    disabled: boolean,
    operatorId: string,
  ): Promise<UserInfo> {
    const user = this.findById(id);
    if (!user) throw new Error("User not found");
    if (id === operatorId) throw new Error("Cannot disable yourself");
    if (
      disabled &&
      user.role === "admin" &&
      this.activeAdminCount(user.tenantId) <= 1
    ) {
      throw new Error("Cannot disable the last active admin");
    }
    user.disabled = disabled || undefined;
    user.disabledAt = disabled ? new Date().toISOString() : undefined;
    user.disabledBy = disabled ? operatorId : undefined;
    user.updatedAt = new Date().toISOString();
    await this.persist();
    const { passwordHash, ...info } = user;
    return info;
  }

  async create(input: CreateUserInput): Promise<UserInfo> {
    if (this.findByUsername(input.username)) {
      throw new Error("Username already exists");
    }
    const now = new Date().toISOString();
    const record: UserRecord = {
      id: this.generateUniqueUserId(),
      username: input.username,
      passwordHash: await bcrypt.hash(input.password, BCRYPT_ROUNDS),
      role: input.role,
      tenantId: input.tenantId || DEFAULT_TENANT_ID,
      ...(input.realName ? { realName: input.realName } : {}),
      ...(input.position ? { position: input.position } : {}),
      ...(input.phone ? { phone: input.phone } : {}),
      ...(input.dingtalkStaffId
        ? { dingtalkStaffId: input.dingtalkStaffId }
        : {}),
      ...(input.debugMode ? { debugMode: true } : {}),
      ...(input.permissions ? { permissions: input.permissions } : {}),
      preferences: { ...DEFAULT_USER_PREFERENCES, ...(input.preferences ?? {}) },
      createdAt: now,
      createdBy: input.createdBy,
      updatedAt: now,
    };
    this.users.push(record);
    await this.persist();
    const { passwordHash, ...info } = record;
    return info;
  }

  private generateUniqueUserId(): string {
    for (let attempt = 0; attempt < USER_ID_MAX_ATTEMPTS; attempt += 1) {
      const id = generateUserId();
      if (!this.findById(id)) return id;
    }
    throw new Error("Failed to generate unique user id");
  }

  async update(id: string, input: UpdateUserInput): Promise<UserInfo> {
    const user = this.findById(id);
    if (!user) throw new Error("User not found");

    const nextRole = input.role ?? user.role;
    const nextTenantId = input.tenantId || user.tenantId;
    const removesActiveAdminFromTenant =
      user.role === "admin" &&
      !user.disabled &&
      (nextRole !== "admin" || nextTenantId !== user.tenantId);

    if (
      removesActiveAdminFromTenant &&
      this.activeAdminCount(user.tenantId) <= 1
    ) {
      throw new Error("Cannot change role of the last admin");
    }

    if (input.password) {
      user.passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    }
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
      user.phone = input.phone || undefined;
    }
    if (input.avatar !== undefined) {
      user.avatar = input.avatar || undefined;
      user.avatarVersion = input.avatar ? Date.now() : undefined;
    }
    if (input.dingtalkStaffId !== undefined) {
      user.dingtalkStaffId = input.dingtalkStaffId || undefined;
    }
    if (input.debugMode !== undefined) {
      user.debugMode = input.debugMode || undefined;
    }
    if (input.tenantId !== undefined) {
      // PR 2 起 tenantId 必选——空字符串/undefined 都视为"不变更"
      if (input.tenantId) user.tenantId = input.tenantId;
    }
    if (input.permissions !== undefined) {
      user.permissions = input.permissions;
    }
    if (input.preferences !== undefined) {
      user.preferences = { ...(user.preferences ?? {}), ...input.preferences };
    }
    user.updatedAt = new Date().toISOString();
    await this.persist();
    const { passwordHash, ...info } = user;
    return info;
  }

  async delete(id: string): Promise<void> {
    const user = this.findById(id);
    if (!user) throw new Error("User not found");
    if (
      user.role === "admin" &&
      !user.disabled &&
      this.activeAdminCount(user.tenantId) <= 1
    ) {
      throw new Error("Cannot delete the last admin");
    }
    this.users = this.users.filter((u) => u.id !== id);
    await this.persist();
  }

  async verifyPassword(
    username: string,
    password: string,
  ): Promise<UserRecord | null> {
    const user = this.findByUsername(username);
    if (!user) return null;
    const valid = await bcrypt.compare(password, user.passwordHash);
    return valid ? user : null;
  }

  /**
   * 更新分组排序偏好。order 由调用方在路由层清洗（剔除不存在的 id、追加缺失的 id）。
   */
  async updateGroupSorting(
    userId: string,
    sorting: GroupSortingPref,
  ): Promise<UserInfo> {
    const user = this.findById(userId);
    if (!user) throw new Error("User not found");
    user.groupSorting = sorting;
    user.updatedAt = new Date().toISOString();
    await this.persist();
    const { passwordHash, ...info } = user;
    return info;
  }

  /** 更新用户偏好。 */
  async updatePreferences(
    userId: string,
    preferences: UserPreferences,
  ): Promise<UserInfo> {
    const user = this.findById(userId);
    if (!user) throw new Error("User not found");
    user.preferences = { ...(user.preferences ?? {}), ...preferences };
    user.updatedAt = new Date().toISOString();
    await this.persist();
    const { passwordHash, ...info } = user;
    return info;
  }

  /** 更新用户的 app 版本号（由 activity 上报时调用） */
  async updateAppVersion(userId: string, version: string): Promise<void> {
    const user = this.findById(userId);
    if (!user) return;
    user.appVersion = version;
    user.appVersionUpdatedAt = new Date().toISOString();
    await this.persist();
  }

  async changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
  ): Promise<boolean> {
    const user = this.findById(userId);
    if (!user) return false;
    const valid = await bcrypt.compare(oldPassword, user.passwordHash);
    if (!valid) return false;
    user.passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    user.updatedAt = new Date().toISOString();
    await this.persist();
    return true;
  }
}
