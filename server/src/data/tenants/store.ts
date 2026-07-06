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
import { writeFile, rename, unlink } from 'node:fs/promises';
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

function mergeSettings(input?: TenantSettingsPatch): TenantSettings {
  return {
    features: { ...DEFAULT_TENANT_SETTINGS.features, ...(input?.features ?? {}) },
    quotas: { ...DEFAULT_TENANT_SETTINGS.quotas, ...(input?.quotas ?? {}) },
    models: {
      ...DEFAULT_TENANT_SETTINGS.models,
      ...(input?.models ?? {}),
      allowedModels: [...(input?.models?.allowedModels ?? DEFAULT_TENANT_SETTINGS.models.allowedModels)],
      displayOverrides: {
        ...(DEFAULT_TENANT_SETTINGS.models.displayOverrides ?? {}),
        ...(input?.models?.displayOverrides ?? {}),
      },
    },
    mcp: {
      ...DEFAULT_TENANT_SETTINGS.mcp,
      ...(input?.mcp ?? {}),
      defaultEnabledServerIds: [...(input?.mcp?.defaultEnabledServerIds ?? DEFAULT_TENANT_SETTINGS.mcp.defaultEnabledServerIds)],
    },
    branding: { ...DEFAULT_TENANT_SETTINGS.branding, ...(input?.branding ?? {}) },
    personalization: { ...DEFAULT_TENANT_SETTINGS.personalization, ...(input?.personalization ?? {}) },
    security: { ...DEFAULT_TENANT_SETTINGS.security, ...(input?.security ?? {}) },
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

export class TenantStore {
  private tenants: TenantRecord[] = [];
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) {
      mkdirSync(dirname(this.filePath), { recursive: true });
      this.tenants = [];
      return;
    }
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const data: TenantsFileData = JSON.parse(raw);
      this.tenants = data.tenants || [];
    } catch (err) {
      authLogger.warn(`Failed to load tenants from ${this.filePath}: ${err}`);
      this.tenants = [];
    }
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
  }

  findById(id: string): TenantRecord | undefined {
    const tenant = this.tenants.find(t => t.id === id);
    return tenant ? { ...tenant, settings: cloneSettings(mergeSettings(tenant.settings)) } : undefined;
  }

  listAll(): TenantRecord[] {
    // 复制一份避免外部突变内部状态
    return this.tenants.map(t => ({ ...t, settings: cloneSettings(mergeSettings(t.settings)) }));
  }

  count(): number {
    return this.tenants.length;
  }

  activeCount(): number {
    return this.tenants.filter(t => !t.disabled).length;
  }

  getSettings(id: string): TenantSettings | undefined {
    const tenant = this.tenants.find(t => t.id === id);
    if (!tenant) return undefined;
    return cloneSettings(mergeSettings(tenant.settings));
  }

  async updateSettings(id: string, input: TenantSettingsPatch): Promise<TenantSettings> {
    const tenant = this.tenants.find(t => t.id === id);
    if (!tenant) throw new Error('Tenant not found');
    tenant.settings = mergeSettings(input);
    tenant.updatedAt = new Date().toISOString();
    await this.persist();
    return cloneSettings(tenant.settings);
  }

  async create(input: CreateTenantInput): Promise<TenantRecord> {
    if (!TENANT_SLUG_PATTERN.test(input.id)) {
      throw new Error(
        `Invalid tenant id "${input.id}": must match ${TENANT_SLUG_PATTERN.source} ` +
        `(小写字母开头，可含小写字母/数字/连字符，长度 2-31)`,
      );
    }
    if (this.findById(input.id)) {
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
    await this.persist();
    return { ...record, settings: cloneSettings(mergeSettings(record.settings)) };
  }

  async update(id: string, input: UpdateTenantInput): Promise<TenantRecord> {
    const tenant = this.tenants.find(t => t.id === id);
    if (!tenant) throw new Error('Tenant not found');
    if (input.name !== undefined) {
      const trimmed = input.name.trim();
      if (!trimmed) throw new Error('Tenant name cannot be empty');
      tenant.name = trimmed;
    }
    tenant.updatedAt = new Date().toISOString();
    await this.persist();
    return { ...tenant, settings: cloneSettings(mergeSettings(tenant.settings)) };
  }

  async setDisabled(id: string, disabled: boolean, operatorId: string): Promise<TenantRecord> {
    const tenant = this.tenants.find(t => t.id === id);
    if (!tenant) throw new Error('Tenant not found');
    if (id === DEFAULT_TENANT_ID && disabled) {
      throw new Error(`Cannot disable the default tenant "${DEFAULT_TENANT_ID}"`);
    }
    if (disabled && this.activeCount() <= 1) {
      throw new Error('Cannot disable the last active tenant');
    }
    tenant.disabled = disabled || undefined;
    tenant.disabledAt = disabled ? new Date().toISOString() : undefined;
    tenant.disabledBy = disabled ? operatorId : undefined;
    tenant.updatedAt = new Date().toISOString();
    await this.persist();
    return { ...tenant, settings: cloneSettings(mergeSettings(tenant.settings)) };
  }

  async delete(id: string): Promise<TenantRecord> {
    const tenant = this.tenants.find(t => t.id === id);
    if (!tenant) throw new Error('Tenant not found');
    if (id === DEFAULT_TENANT_ID) {
      throw new Error(`Cannot delete the default tenant "${DEFAULT_TENANT_ID}"`);
    }
    this.tenants = this.tenants.filter(t => t.id !== id);
    await this.persist();
    return { ...tenant, settings: cloneSettings(mergeSettings(tenant.settings)) };
  }

  /**
   * 启动期幂等保证默认组织存在。
   * 用 'system' 作为 createdBy；如果已存在则不动。
   */
  async ensureDefaultTenant(): Promise<TenantRecord> {
    const existing = this.findById(DEFAULT_TENANT_ID);
    if (existing) return { ...existing, settings: cloneSettings(mergeSettings(existing.settings)) };
    return await this.create({
      id: DEFAULT_TENANT_ID,
      name: '万神殿',
      createdBy: 'system',
    });
  }

  /** 迁移期保证开沿日常组织存在；平台根组织不再承载日常协作。 */
  async ensureKaiyanTenant(): Promise<TenantRecord> {
    const existing = this.findById(LEGACY_TENANT_ID);
    if (existing) return { ...existing, settings: cloneSettings(mergeSettings(existing.settings)) };
    return await this.create({
      id: LEGACY_TENANT_ID,
      name: '开沿科技',
      createdBy: 'system',
    });
  }
}
