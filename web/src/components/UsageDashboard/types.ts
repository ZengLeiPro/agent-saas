/**
 * 与 server/src/data/usage/store.ts 的输出类型保持一致。
 * 不跨包 import（web 不依赖 server），手工镜像。
 */

export type RangePreset = "today" | "7d" | "30d" | "mtd" | "all" | "custom";

/**
 * 模型家族筛选（与后端 querySchema.family 同枚举）：
 *   - 'claude' = model LIKE 'claude%'
 *   - 'gpt'    = model LIKE 'gpt%'
 *   - 'other'  = 其余（doubao / glm / kimi / MiniMax 等）
 *   - undefined / 'all' 由前端用 undefined 表示「不过滤」
 */
export type ModelFamily = "claude" | "gpt" | "other";

export interface OverviewStats {
  fromDate: string;
  toDate: string;
  range: RangePreset;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalTokens: number;
  /** 组织 admin 且 policy.showCost !== true 时后端剥离（2026-07-14） */
  totalCostUsd?: number;
  totalTurns: number;
  activeUsers: number;
  cacheHitRatio: number | null;
  /** 后端成本脱敏标记 */
  costRedacted?: boolean;
}

export interface UserAggregate {
  username: string;
  realName?: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalTokens: number;
  /** 组织 admin 且 policy.showCost !== true 时后端剥离 */
  totalCostUsd?: number;
  totalTurns: number;
  cacheHitRatio: number | null;
  lastActiveDate: string;
}

export interface ByUserResp {
  fromDate: string;
  toDate: string;
  range: RangePreset;
  users: UserAggregate[];
  /** 后端成本脱敏标记 */
  costRedacted?: boolean;
}

export interface ModelAggregate {
  model: string;
  totalTokens: number;
  /** 组织 admin 且 policy.showCost !== true 时后端剥离 */
  totalCostUsd?: number;
  totalTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface ChannelAggregate {
  channel: string;
  totalTokens: number;
  /** 组织 admin 且 policy.showCost !== true 时后端剥离 */
  totalCostUsd?: number;
  totalTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface ByChannelResp {
  fromDate: string;
  toDate: string;
  range: RangePreset;
  username: string | null;
  channels: ChannelAggregate[];
  /** 后端成本脱敏标记 */
  costRedacted?: boolean;
}

export interface ByModelResp {
  fromDate: string;
  toDate: string;
  range: RangePreset;
  username: string | null;
  models: ModelAggregate[];
  /** 后端成本脱敏标记 */
  costRedacted?: boolean;
}

export interface DailyTrendRow {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  /** 组织 admin 且 policy.showCost !== true 时后端剥离 */
  costUsd?: number;
  turns: number;
}

export interface TrendResp {
  fromDate: string;
  toDate: string;
  range: RangePreset;
  /** 全公司聚合时为 null；按用户时为对应 username */
  username: string | null;
  realName: string | null;
  points: DailyTrendRow[];
  /** 后端成本脱敏标记 */
  costRedacted?: boolean;
}

export interface DataRangeResp {
  earliestDate: string | null;
  latestDate: string | null;
  firstCostDate: string | null;
  rebuild: {
    lastRebuildAtMs: number;
    totalFilesScanned: number;
    totalRowsBuilt: number;
  } | null;
}
