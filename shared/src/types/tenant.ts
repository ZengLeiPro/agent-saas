/**
 * Tenant (组织) 前端共享类型。
 *
 * 后端权威源在 server/src/data/tenants/types.ts；这里只镜像前端展示/交互
 * 用得到的字段与常量，避免硬编码 'kaiyan' 字面值散落在 web 各处。
 */

/** 平台根组织 slug。 */
export const PLATFORM_TENANT_ID = "pantheon";

/** 历史默认组织 slug；现在作为开沿日常组织使用。 */
export const LEGACY_TENANT_ID = "kaiyan";

/** 兼容旧调用方的默认组织常量。 */
export const DEFAULT_TENANT_ID = PLATFORM_TENANT_ID;

export function isInternalTenantId(tenantId: string | undefined | null): boolean {
  return tenantId === PLATFORM_TENANT_ID || tenantId === LEGACY_TENANT_ID;
}

/** Tenant slug 规范：以小写字母开头，可含小写字母、数字、连字符，长度 2-31 */
export const TENANT_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;

/**
 * 前端展示用的 Tenant 记录。后端 `/api/tenants` 列表项原样转过来。
 * Slug（id）建后不可改；name 可改；disabled 仅默认组织外可切换。
 */
export interface Tenant {
  id: string;
  name: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  disabled?: boolean;
  disabledAt?: string;
  disabledBy?: string;
  settings?: TenantSettings;
}

export interface TenantSettings {
  features: {
    filesEnabled: boolean;
    cronEnabled: boolean;
    mcpEnabled: boolean;
    customSkillsEnabled: boolean;
    debugModeAllowed: boolean;
    /** 会话上下文自动压缩（post-run 超阈值触发）。默认关闭。 */
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
    displayOverrides?: Record<
      string,
      {
        displayName?: string;
        description?: string;
        recommended?: boolean;
        sortOrder?: number;
        groupDisplayName?: string;
      }
    >;
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
  personalization: {
    /** 首日新手引导条。默认关闭，由平台/组织管理员按租户开启。 */
    firstDayGuideBarEnabled: boolean;
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
  personalization: {
    firstDayGuideBarEnabled: false,
  },
  security: {
    requireDingtalkBinding: false,
  },
};

export interface CreateTenantInput {
  id: string;
  name: string;
}

export interface UpdateTenantInput {
  name?: string;
}
