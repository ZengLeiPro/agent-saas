/**
 * 套餐额度看板：跨供应商归一化的用量快照。
 *
 * 服务端按周期向各家「管控面」取数（Codex = wham/usage，火山 = Ark OpenAPI GetAFPUsage），
 * 落 PG 后由平台管理端展示。推理 API Key 本身查不到套餐额度，这里的数据源是账号级凭据。
 */
export type ProviderQuotaSourceKind = 'codex_subscription' | 'volcengine_ark_plan';

export interface ProviderQuotaWindow {
  /** 同一账号内唯一，例如 five_hour / weekly / codex_bengalfox:primary。 */
  id: string;
  /** 直接展示的中文标签。 */
  label: string;
  windowSeconds?: number;
  /** 已用百分比 0~100（撞限时可能 ≥100）。 */
  usedPercent: number;
  used?: number;
  quota?: number;
  unit?: string;
  /** ISO 时间；缺省表示供应商未给出。 */
  resetAt?: string;
  limitReached?: boolean;
}

export interface ProviderQuotaPlanInfo {
  type?: string;
  status?: string;
  startTime?: string;
  endTime?: string;
  autoRenew?: boolean;
}

/** 凭据/调度侧状态（Codex 订阅账号）：看板据此区分「真撞限」与「token 过期 / 正在被调度器绕开」。 */
export interface ProviderQuotaCredentialState {
  expiresAt?: string;
  accessTokenExpired?: boolean;
  availability?: 'available' | 'quota_cooldown' | 'auth_unavailable';
  cooldownUntil?: string;
  lastFailureCode?: string;
}

export interface ProviderQuotaSnapshot {
  sourceKind: ProviderQuotaSourceKind;
  /** 稳定账号键：codex:<credentialRef> / volcengine:<groupId>。 */
  accountKey: string;
  /** 账号邮箱、分组名等人读标识。 */
  accountLabel: string;
  /** 所属模型分组 id（火山按分组配置；Codex 订阅无分组）。 */
  groupId?: string;
  plan?: ProviderQuotaPlanInfo;
  windows: ProviderQuotaWindow[];
  limitReached: boolean;
  /** Codex：可用的额度重置券张数（rate_limit_reset_credits.available_count）。 */
  resetCredits?: number;
  credential?: ProviderQuotaCredentialState;
  /** false 时 windows 为空，error 记录采集失败原因。 */
  ok: boolean;
  error?: string;
  collectedAt: string;
  /** 供应商特有补充信息（如 Codex credits），只做展示。 */
  extra?: Record<string, unknown>;
}

export interface ProviderQuotaHistoryPoint {
  accountKey: string;
  collectedAt: string;
  ok: boolean;
  windows: Array<Pick<ProviderQuotaWindow, 'id' | 'usedPercent'>>;
}

export interface ProviderQuotaCollectorStatus {
  enabled: boolean;
  intervalMs: number;
  lastRunAt: string | null;
  lastError: string | null;
}

export interface ProviderQuotaOverviewResponse {
  items: ProviderQuotaSnapshot[];
  collector: ProviderQuotaCollectorStatus;
  generatedAt: string;
}

export interface ProviderQuotaHistoryResponse {
  hours: number;
  points: ProviderQuotaHistoryPoint[];
  generatedAt: string;
}

export interface ProviderQuotaTestRequest {
  provider: 'volcengine_ark_plan';
  accessKeyId: string;
  /** 留空时按 groupId 使用已保存的 Secret。 */
  secretAccessKey?: string;
  groupId?: string;
  region?: string;
}

export interface ProviderQuotaTestResponse {
  plan?: ProviderQuotaPlanInfo;
  windows: ProviderQuotaWindow[];
  limitReached: boolean;
}
