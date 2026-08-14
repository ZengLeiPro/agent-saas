/**
 * TenantStore — 组织元数据 file-backed store
 *
 * 形态参考 `data/users/store.ts`：单文件 JSON + 同步 load + 异步 tmpfile+rename 原子写入。
 * 不分 file/pg 后端——组织记录极少（数量级 ~10），无需 PG。
 *
 * PR 1 范围：仅 CRUD + ensureDefaultTenant。
 * 后续 PR 会接入 tenant-aware path / JWT / event store。
 */

import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { open, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { authLogger } from '../../utils/logger.js';
import {
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_SETTINGS,
  LEGACY_TENANT_ID,
  TENANT_SLUG_PATTERN,
  type TenantRecord,
  type TenantSettings,
  type TenantsFileData,
} from './types.js';


function cloneSettings(settings: TenantSettings): TenantSettings {
  return {
    features: { ...settings.features },
    quotas: { ...settings.quotas },
    models: {
      ...settings.models,
      allowedModels: [...settings.models.allowedModels],
      displayOverrides: { ...(settings.models.displayOverrides ?? {}) },
    },
    mcp: {
      ...settings.mcp,
      defaultEnabledServerIds: [...settings.mcp.defaultEnabledServerIds],
    },
    branding: { ...settings.branding },
    personalization: { ...settings.personalization },
    security: { ...settings.security },
  };
}

type TenantSettingsPatch = { [K in keyof TenantSettings]?: Partial<TenantSettings[K]> };

/**
 * 以 base 为基底逐 section 合并 patch。
 * base 缺省为 DEFAULT_TENANT_SETTINGS——「存储稀疏值补全默认」的读路径语义；
 * updateSettings 写路径必须传入租户现值作 base，否则 patch 缺省的 section
 * （quotas/mcp/branding/security）会被静默重置为平台默认（2026-07-19 修复的 P1）。
 */
function mergeSettings(input?: TenantSettingsPatch, base: TenantSettings = DEFAULT_TENANT_SETTINGS): TenantSettings {
  const models = {
    ...base.models,
    ...(input?.models ?? {}),
    allowedModels: [...(input?.models?.allowedModels ?? base.models.allowedModels)],
    displayOverrides: {
      ...(base.models.displayOverrides ?? {}),
      ...(input?.models?.displayOverrides ?? {}),
    },
  };
  if (models.showContextTokens === false) {
    models.allowContextTokenDetails = false;
  }

  return {
    features: { ...base.features, ...(input?.features ?? {}) },
    quotas: { ...base.quotas, ...(input?.quotas ?? {}) },
    models,
    mcp: {
      ...base.mcp,
      ...(input?.mcp ?? {}),
      defaultEnabledServerIds: [...(input?.mcp?.defaultEnabledServerIds ?? base.mcp.defaultEnabledServerIds)],
    },
    branding: { ...base.branding, ...(input?.branding ?? {}) },
    personalization: { ...base.personalization, ...(input?.personalization ?? {}) },
    security: { ...base.security, ...(input?.security ?? {}) },
  };
}

export interface CreateTenantInput {
  /** Slug，必须符合 TENANT_SLUG_PATTERN，全局唯一。 */
  id: string;
  name: string;
  createdBy: string;
}

export interface UpdateTenantInput {
  /** 修改人类可读名称（slug 不可改） */
  name?: string;
}

export interface TenantStoreOptions {
  /** 生产 PG advisory lock；未提供时退化为跨进程文件锁。 */
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

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_RETRY_MS = 20;

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code)
    : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function lifecycleConflict(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function nextUpdatedAt(previous: string): string {
  const previousMs = Date.parse(previous);
  const nextMs = Number.isFinite(previousMs) ? Math.max(Date.now(), previousMs + 1) : Date.now();
  return new Date(nextMs).toISOString();
}

export class TenantStore {
  private tenants: TenantRecord[] = [];
  private readonly filePath: string;
  private readonly options: TenantStoreOptions;
  private postPersistObserver?: () => void;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string, options: TenantStoreOptions = {}) {
    this.filePath = filePath;
    this.options = options;
    this.load();
  }

  private load(strict = false): void {
    if (!existsSync(this.filePath)) {
      mkdirSync(dirname(this.filePath), { recursive: true });
      this.tenants = [];
      return;
    }
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const data: TenantsFileData = JSON.parse(raw);
      if (data.version !== 1 || !Array.isArray(data.tenants)) {
        throw new Error('Invalid tenants file structure');
      }
      this.tenants = data.tenants;
    } catch (err) {
      authLogger.warn(`Failed to load tenants from ${this.filePath}: ${err}`);
      if (strict) throw err;
      this.tenants = [];
    }
  }

  /** 重新读取共享 tenants.json，供多进程后台执行器刷新组织开关。 */
  reload(): void {
    this.load();
  }

  private refreshForRead(): void {
    this.load();
  }

  setPostPersistObserver(observer: (() => void) | undefined): void {
    this.postPersistObserver = observer;
  }

  private async persist(): Promise<void> {
    const data: TenantsFileData = { version: 1, tenants: this.tenants };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = join(dirname(this.filePath), `.tenants.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    try {
      await rename(tmpPath, this.filePath);
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      throw err;
    }
    try {
      this.postPersistObserver?.();
    } catch (error) {
      authLogger.warn(`Tenant post-persist observer failed: ${error}`);
    }
  }

  private async acquireLocalLock(): Promise<LocalLock> {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const lockPath = `${this.filePath}.lock`;
    const timeoutMs = Math.max(0, this.options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
    const retryMs = Math.max(1, this.options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS);
    const deadline = Date.now() + timeoutMs;
    const token = randomBytes(16).toString('hex');

    for (;;) {
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(lockPath, 'wx', 0o600);
        await handle.writeFile(token, 'utf-8');
        return { handle, token };
      } catch (err) {
        await handle?.close().catch(() => undefined);
        if (handle) await unlink(lockPath).catch(() => undefined);
        if (errorCode(err) !== 'EEXIST') throw err;
        if (Date.now() >= deadline) {
          throw new Error(`Timed out acquiring tenant store lock: ${lockPath}`);
        }
        await sleep(Math.min(retryMs, Math.max(1, deadline - Date.now())));
      }
    }
  }

  private async releaseLocalLock(lock: LocalLock): Promise<void> {
    const lockPath = `${this.filePath}.lock`;
    await lock.handle.close().catch(() => undefined);
    try {
      const currentToken = await readFile(lockPath, 'utf-8');
      if (currentToken === lock.token) await unlink(lockPath);
    } catch (err) {
      if (errorCode(err) !== 'ENOENT') {
        authLogger.warn(`Failed to release tenant store lock ${lockPath}: ${err}`);
      }
    }
  }

  private async mutate<T>(operation: () => MutationResult<T> | Promise<MutationResult<T>>): Promise<T> {
    const execute = async (): Promise<T> => {
      try {
        this.load(true);
        const result = await operation();
        if (result.changed) await this.persist();
        return result.value;
      } catch (error) {
        this.load();
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
    this.mutationQueue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  findById(id: string): TenantRecord | undefined {
    this.refreshForRead();
    const tenant = this.tenants.find(t => t.id === id);
    return tenant ? { ...tenant, settings: cloneSettings(mergeSettings(tenant.settings)) } : undefined;
  }

  listAll(): TenantRecord[] {
    this.refreshForRead();
    // 复制一份避免外部突变内部状态
    return this.tenants.map(t => ({ ...t, settings: cloneSettings(mergeSettings(t.settings)) }));
  }

  async reorder(ids: string[]): Promise<TenantRecord[]> {
    return this.mutate(() => {
      if (ids.length !== this.tenants.length || new Set(ids).size !== ids.length) {
        throw new Error('Tenant order must contain every tenant exactly once');
      }
      const tenantsById = new Map(this.tenants.map(tenant => [tenant.id, tenant]));
      if (ids.some(id => !tenantsById.has(id))) {
        throw new Error('Tenant order contains unknown tenant');
      }
      this.tenants = ids.map(id => tenantsById.get(id)!);
      return {
        changed: true,
        value: this.tenants.map(tenant => ({
          ...tenant,
          settings: cloneSettings(mergeSettings(tenant.settings)),
        })),
      };
    });
  }

  count(): number {
    this.refreshForRead();
    return this.tenants.length;
  }

  activeCount(): number {
    this.refreshForRead();
    return this.tenants.filter(t => !t.disabled).length;
  }

  getSettings(id: string): TenantSettings | undefined {
    this.refreshForRead();
    const tenant = this.tenants.find(t => t.id === id);
    if (!tenant) return undefined;
    return cloneSettings(mergeSettings(tenant.settings));
  }

  async updateSettings(id: string, input: TenantSettingsPatch): Promise<TenantSettings> {
    return this.mutate(() => {
      const tenant = this.tenants.find(t => t.id === id);
      if (!tenant) throw new Error('Tenant not found');
      // 基底=租户现值（先补全默认），patch 缺省的 section 保留现值而非重置为平台默认
      tenant.settings = mergeSettings(input, mergeSettings(tenant.settings));
      tenant.updatedAt = nextUpdatedAt(tenant.updatedAt);
      return { changed: true, value: cloneSettings(tenant.settings) };
    });
  }

  async create(input: CreateTenantInput): Promise<TenantRecord> {
    return this.mutate(() => {
      if (!TENANT_SLUG_PATTERN.test(input.id)) {
        throw new Error(
          `Invalid tenant id "${input.id}": must match ${TENANT_SLUG_PATTERN.source} ` +
          `(小写字母开头，可含小写字母/数字/连字符，长度 2-31)`,
        );
      }
      if (this.tenants.some(tenant => tenant.id === input.id)) {
        throw new Error(`Tenant id "${input.id}" already exists`);
      }
      if (!input.name || !input.name.trim()) {
        throw new Error('Tenant name cannot be empty');
      }
      const now = new Date().toISOString();
      const record: TenantRecord = {
        id: input.id,
        name: input.name.trim(),
        createdAt: now,
        createdBy: input.createdBy,
        updatedAt: now,
        settings: cloneSettings(DEFAULT_TENANT_SETTINGS),
      };
      this.tenants.push(record);
      return {
        changed: true,
        value: { ...record, settings: cloneSettings(mergeSettings(record.settings)) },
      };
    });
  }

  async update(id: string, input: UpdateTenantInput): Promise<TenantRecord> {
    return this.mutate(() => {
      const tenant = this.tenants.find(t => t.id === id);
      if (!tenant) throw new Error('Tenant not found');
      if (input.name !== undefined) {
        if (id === DEFAULT_TENANT_ID) {
          throw new Error(`Cannot rename the default tenant "${DEFAULT_TENANT_ID}"`);
        }
        const trimmed = input.name.trim();
        if (!trimmed) throw new Error('Tenant name cannot be empty');
        tenant.name = trimmed;
      }
      tenant.updatedAt = nextUpdatedAt(tenant.updatedAt);
      return {
        changed: true,
        value: { ...tenant, settings: cloneSettings(mergeSettings(tenant.settings)) },
      };
    });
  }

  async setDisabled(
    id: string,
    disabled: boolean,
    operatorId: string,
    expectedUpdatedAt?: string,
  ): Promise<TenantRecord> {
    return this.mutate(() => {
      const tenant = this.tenants.find(t => t.id === id);
      if (!tenant) throw new Error('Tenant not found');
      if (expectedUpdatedAt !== undefined && tenant.updatedAt !== expectedUpdatedAt) {
        throw lifecycleConflict('Tenant lifecycle baseline changed', 'TENANT_LIFECYCLE_BASELINE_CONFLICT');
      }
      if (Boolean(tenant.disabled) === disabled) {
        throw lifecycleConflict('Tenant lifecycle transition conflict', 'TENANT_LIFECYCLE_TRANSITION_CONFLICT');
      }
      if (id === DEFAULT_TENANT_ID && disabled) {
        throw new Error(`Cannot disable the default tenant "${DEFAULT_TENANT_ID}"`);
      }
      if (disabled && this.tenants.filter(candidate => !candidate.disabled).length <= 1) {
        throw new Error('Cannot disable the last active tenant');
      }
      const updatedAt = nextUpdatedAt(tenant.updatedAt);
      tenant.disabled = disabled || undefined;
      tenant.disabledAt = disabled ? updatedAt : undefined;
      tenant.disabledBy = disabled ? operatorId : undefined;
      tenant.updatedAt = updatedAt;
      return {
        changed: true,
        value: { ...tenant, settings: cloneSettings(mergeSettings(tenant.settings)) },
      };
    });
  }

  async delete(id: string): Promise<TenantRecord> {
    return this.mutate(() => {
      const tenant = this.tenants.find(t => t.id === id);
      if (!tenant) throw new Error('Tenant not found');
      if (id === DEFAULT_TENANT_ID) {
        throw new Error(`Cannot delete the default tenant "${DEFAULT_TENANT_ID}"`);
      }
      this.tenants = this.tenants.filter(t => t.id !== id);
      return {
        changed: true,
        value: { ...tenant, settings: cloneSettings(mergeSettings(tenant.settings)) },
      };
    });
  }

  private async ensureTenant(id: string, name: string): Promise<TenantRecord> {
    return this.mutate(() => {
      const existing = this.tenants.find(tenant => tenant.id === id);
      if (existing) {
        return {
          changed: false,
          value: { ...existing, settings: cloneSettings(mergeSettings(existing.settings)) },
        };
      }
      const now = new Date().toISOString();
      const record: TenantRecord = {
        id,
        name,
        createdAt: now,
        createdBy: 'system',
        updatedAt: now,
        settings: cloneSettings(DEFAULT_TENANT_SETTINGS),
      };
      this.tenants.push(record);
      return {
        changed: true,
        value: { ...record, settings: cloneSettings(mergeSettings(record.settings)) },
      };
    });
  }

  /** 启动期幂等保证默认组织存在。 */
  async ensureDefaultTenant(): Promise<TenantRecord> {
    return this.ensureTenant(DEFAULT_TENANT_ID, '万神殿');
  }

  /** 迁移期保证开沿日常组织存在；平台根组织不再承载日常协作。 */
  async ensureKaiyanTenant(): Promise<TenantRecord> {
    return this.ensureTenant(LEGACY_TENANT_ID, '开沿科技');
  }
}
