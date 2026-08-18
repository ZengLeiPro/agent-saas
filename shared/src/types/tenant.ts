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

export function isDebugModeAvailable(
  tenantId: string | undefined | null,
  features: Pick<TenantSettings["features"], "debugModeAllowed" | "debugModeEnabled"> | undefined,
): boolean {
  // 平台根组织只承载平台管理员，保留其内部调试能力；客户组织必须同时满足
  // 平台授权与组织开关，缺失字段按 false 处理，绝不从上级开关回退推导。
  if (tenantId === PLATFORM_TENANT_ID) return true;
  return features?.debugModeAllowed === true && features.debugModeEnabled === true;
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

export type TenantMemoryFeatureKey =
  | "memoryPollingEnabled"
  | "memoryConsolidationEnabled"
  | "memoryWriteDelegationEnabled";

export type TenantMemoryFeatureBlockedBy =
  | "platform_disabled"
  | "dependency_disabled"
  | "runtime_unavailable";

export interface TenantMemoryFeatureStatus {
  /** 租户持久化开关值；与 effective 分开展示，避免“勾选=已运行”的假象。 */
  configured: boolean;
  /** 平台总开关、依赖与运行时能力均满足时才为 true。 */
  effective: boolean;
  blockedBy?: TenantMemoryFeatureBlockedBy;
}

export type TenantMemoryFeatureStatusMap = Record<TenantMemoryFeatureKey, TenantMemoryFeatureStatus>;

export interface TenantSettingsResponse {
  tenantId: string;
  settings: TenantSettings;
  memoryFeatureStatus?: TenantMemoryFeatureStatusMap;
}

export interface TenantSettings {
  features: {
    filesEnabled: boolean;
    cronEnabled: boolean;
    mcpEnabled: boolean;
    customSkillsEnabled: boolean;
    /** 平台是否授权该组织使用调试模式。仅平台管理员可配置。 */
    debugModeAllowed: boolean;
    /** 组织是否向成员开放调试模式；旧数据缺省按 false 处理。 */
    debugModeEnabled?: boolean;
    /** 会话上下文自动压缩（达到各模型配置的触发线后 post-run 触发）。默认关闭。 */
    autoCompactEnabled: boolean;
    /** 每日记忆轮询（2026-07-14 批次）。默认关闭，开启后为每个有效用户自动预置系统任务。 */
    memoryPollingEnabled?: boolean;
    /** 记忆轮询是否扣租户积分（默认不扣：用量照记但不产生 debit）。 */
    memoryPollChargesCredits?: boolean;
    /** L2 会话级记忆整合（2026-07-29 记忆写入职责剥离批次）。默认关闭。 */
    memoryConsolidationEnabled?: boolean;
    /** 记忆写入职责剥离 v2：新会话主 Agent 不自由写记忆、启用 MemoryCommand。默认关闭。 */
    memoryWriteDelegationEnabled?: boolean;
    /** 平台托管 AI 生图租户授权。默认关闭，仅平台管理员可配置。 */
    imageGenEnabled?: boolean;
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
    /** 是否允许组织成员点击展开上下文/Token 明细。仅平台管理员可配置，缺省 = false。 */
    allowContextTokenDetails?: boolean;
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
    debugModeEnabled: false,
    autoCompactEnabled: false,
    memoryPollingEnabled: false,
    memoryPollChargesCredits: false,
    memoryConsolidationEnabled: false,
    memoryWriteDelegationEnabled: false,
    imageGenEnabled: false,
  },
  quotas: {},
  models: {
    allowedModels: [],
    allowUserModelSwitch: true,
    showGroupNames: false,
    showContextTokens: true,
    allowContextTokenDetails: false,
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
