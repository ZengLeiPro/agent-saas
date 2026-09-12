/**
 * 套餐额度看板：跨供应商归一化的用量快照。
 *
 * 服务端按周期向各家管控面取数，落 PG 后由平台管理端展示。
 * 火山需要独立 AccessKey；智谱个人 Coding Plan 复用模型分组 API Key，返回账号共享额度。
 *
 * claude_subscription 是推送型来源：额度由官方客户端真实会话带出，
 * KY Agent 侧采集后直接写快照表，平台不主动取数。
 */
export type ProviderQuotaSourceKind =
  | 'codex_subscription'
  | 'grok_subscription'
  | 'volcengine_ark_plan'
  | 'claude_subscription'
  | 'zhipu_coding_plan';

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

/** 凭据/调度侧状态（Codex 订阅账号）：区分撞限与凭据不可用。 */
export interface ProviderQuotaCredentialState {
  expiresAt?: string;
  accessTokenExpired?: boolean;
  availability?: 'available' | 'quota_cooldown' | 'auth_unavailable';
  cooldownUntil?: string;
  lastFailureCode?: string;
}

export interface ProviderQuotaSnapshot {
  sourceKind: ProviderQuotaSourceKind;
  /** 稳定键：codex:<credentialRef> / volcengine:<groupId> / claude:<email> / zhipu:<groupId>。 */
  accountKey: string;
  /** 账号邮箱、分组名等人读标识。 */
  accountLabel: string;
  /** 所属模型分组 id（火山和智谱按分组配置）。 */
  groupId?: string;
  plan?: ProviderQuotaPlanInfo;
  /** 仅概览附加的手动设置；采集快照与供应商 plan 保持原样。 */
  planExpiry?: {
    editable: boolean;
    endTime?: string;
    manualEndTime?: string;
    providerEndTime?: string;
    note?: string;
  };
  windows: ProviderQuotaWindow[];
  limitReached: boolean;
  /** Codex：可用的额度重置券张数（rate_limit_reset_credits.available_count）。 */
  resetCredits?: number;
  credential?: ProviderQuotaCredentialState;
  /** false 时采集失败；概览保留上次成功窗口，采集时间停留在 lastSuccessAt。 */
  ok: boolean;
  error?: string;
  collectedAt: string;
  /** 供应商特有补充信息；禁止放入凭据或完整上游响应。 */
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

export type ProviderQuotaTestRequest =
  | {
      provider: 'volcengine_ark_plan';
      accessKeyId: string;
      /** 留空时按 groupId 使用已保存的 Secret。 */
      secretAccessKey?: string;
      groupId?: string;
      region?: string;
    }
  | {
      provider: 'zhipu_coding_plan';
      /** 仅测试未保存的 Key；留空时按 groupId 读取分组已保存的 Key。 */
      apiKey?: string;
      groupId?: string;
    };

export interface ProviderQuotaTestResponse {
  plan?: ProviderQuotaPlanInfo;
  windows: ProviderQuotaWindow[];
  limitReached: boolean;
}

/**
 * 模型配置与采集器共用的来源判定。历史官方地址自动接入；显式来源（包括 none）优先。
 * 精确校验 HTTPS origin，避免用子串匹配将相似域名当作智谱官方。
 */
export function isZhipuCodingPlanGroup(group: {
  baseUrl?: string | null;
  quotaSource?: { provider: string };
}): boolean {
  if (group.quotaSource) return group.quotaSource.provider === 'zhipu_coding_plan';
  try {
    const url = new URL(group.baseUrl ?? '');
    return url.origin === 'https://open.bigmodel.cn' && !url.username && !url.password;
  } catch {
    return false;
  }
}
