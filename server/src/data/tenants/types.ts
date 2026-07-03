/**
 * Tenant (组织) 数据类型
 *
 * 多组织全栈改造 PR 1：仅引入 TenantStore 抽象，不改任何运行时行为。
 * 后续 PR 会逐步把 JwtPayload / workspace 路径 / runtime_events / settings.json
 * 接入 tenantId；当前 PR 只是把"组织作为一等公民"的骨架铺出来。
 *
 * 设计决策：
 *   - tenantId 形式 = slug（人类可读，路径/配置/审计友好）
 *   - slug 规范 `^[a-z][a-z0-9-]{1,30}$`，全局唯一
 *   - 建后只能 disable 不能 rename（避免路径/审计追溯断裂）
 *   - 平台根组织 slug = 'pantheon'（万神殿），只承载最高权限账号
 *   - 开沿日常组织 slug = 'kaiyan'（开沿科技），不再等同平台根组织
 */

/** Tenant 唯一标识规范：以小写字母开头，可含小写字母、数字、连字符；长度 2-31 */
export const TENANT_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;

/** 平台根组织 slug。在启动期由 TenantStore 自动 ensure，永不缺席。 */
export const PLATFORM_TENANT_ID = 'pantheon';

/** 历史默认组织 slug。用于旧数据投影/回填，不再代表平台根组织。 */
export const LEGACY_TENANT_ID = 'kaiyan';

/**
 * 兼容旧调用方的默认组织常量。
 * 新代码表达平台权限时优先使用 PLATFORM_TENANT_ID；处理历史数据时使用 LEGACY_TENANT_ID。
 */
export const DEFAULT_TENANT_ID = PLATFORM_TENANT_ID;

export function isInternalTenantId(tenantId: string | undefined | null): boolean {
  return tenantId === PLATFORM_TENANT_ID || tenantId === LEGACY_TENANT_ID;
}


export interface TenantSettings {
  features: {
    filesEnabled: boolean;
    cronEnabled: boolean;
    mcpEnabled: boolean;
    customSkillsEnabled: boolean;
    debugModeAllowed: boolean;
    /**
     * 会话上下文自动压缩（post-run 超阈值触发）。默认关闭，灰度租户先开。
     * 生效还需模型配置 context_window（见 config.json models）。
     */
    autoCompactEnabled: boolean;
  };
  quotas: {
    maxUsers?: number;
    maxAdmins?: number;
    maxStorageMb?: number;
    monthlyTokenLimit?: number;
    maxTurnsPerRequest?: number;
    rateLimitMaxRequests?: number;
  };
  models: {
    defaultModel?: string;
    allowedModels: string[];
    allowUserModelSwitch: boolean;
    showGroupNames: boolean;
    /** 是否向组织成员显示顶部上下文/Token 统计。缺省 = true（显示）。 */
    showContextTokens?: boolean;
    displayOverrides?: Record<string, {
      displayName?: string;
      description?: string;
      recommended?: boolean;
      sortOrder?: number;
      groupDisplayName?: string;
    }>;
  };
  mcp: {
    allowTenantServers: boolean;
    allowGlobalServers: boolean;
    defaultEnabledServerIds: string[];
  };
  branding: {
    displayName?: string;
    logoUrl?: string;
    primaryColor?: string;
  };
  security: {
    passwordMinLength?: number;
    sessionTtlHours?: number;
    requireDingtalkBinding: boolean;
  };
}

export const DEFAULT_TENANT_SETTINGS: TenantSettings = {
  features: {
    filesEnabled: true,
    cronEnabled: true,
    mcpEnabled: true,
    customSkillsEnabled: true,
    debugModeAllowed: false,
    autoCompactEnabled: false,
  },
  quotas: {},
  models: {
    allowedModels: [],
    allowUserModelSwitch: true,
    showGroupNames: false,
    showContextTokens: true,
    displayOverrides: {},
  },
  mcp: {
    allowTenantServers: true,
    allowGlobalServers: true,
    defaultEnabledServerIds: [],
  },
  branding: {},
  security: {
    requireDingtalkBinding: false,
  },
};

export interface TenantRecord {
  /** Slug（同时是主键和路径/配置 key）。建后不可改。 */
  id: string;
  /** 人类可读名称，可改（如「开沿科技」「唯恩电气」）。 */
  name: string;
  /** ISO 8601 创建时间 */
  createdAt: string;
  /** 创建者 userId 或 'system'（启动期 ensureDefaultTenant 用 'system'） */
  createdBy: string;
  /** ISO 8601 最近更新时间 */
  updatedAt: string;
  /** 软删除标记。disabled tenant 仍占用 slug，但被禁止接入新用户/会话。 */
  disabled?: boolean;
  disabledAt?: string;
  disabledBy?: string;
  settings?: TenantSettings;
}

export interface TenantsFileData {
  version: 1;
  tenants: TenantRecord[];
}
