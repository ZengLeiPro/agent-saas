import type { UserInfo } from "@/components/UserManager/types";

export type SearchMatchKind = "run" | "session" | "user" | "tenant" | "sandbox" | "workspace";

export interface PlatformSearchMatch {
  kind: SearchMatchKind;
  id: string;
  title: string;
  subtitle?: string;
  href: string;
}

export interface TenantOverviewItem {
  id: string;
  name: string;
  disabled: boolean;
  userCount: number;
  adminCount: number;
  activeRuns: number;
  sessions7d: number;
  costYuan30d: number;
  balanceCredits: number | null;
  lastActiveAt: string | null;
}

export interface TenantOverviewResponse {
  items: TenantOverviewItem[];
  generatedAt: string;
}

export interface PagedResponse<T> {
  items: T[];
  nextCursor?: string;
}

export interface PlatformSessionRecord {
  sessionId: string;
  tenantId: string;
  userId: string | null;
  username: string | null;
  realName: string | null;
  channel: string | null;
  kind: "user" | "subagent";
  title: string | null;
  runtimeStatus: string | null;
  model: string | null;
  executionTarget: string | null;
  workspaceId: string | null;
  createdAt: string | null;
  updatedAt: string;
  deletedAt: string | null;
  totalCostUsd: number | null;
  meta: Record<string, unknown> | null;
}

export interface PlatformRunRecord {
  runId: string;
  sessionId: string;
  tenantId: string | null;
  userId: string | null;
  username: string | null;
  realName: string | null;
  status: string;
  statusReason: string | null;
  model: string | null;
  channel: string | null;
  requestedAt: string | null;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
  workerId: string | null;
  executionTarget: string | null;
  workspaceId: string | null;
  sandboxScopeId: string | null;
  cumulativeInputTokens: number;
}

export interface SandboxOwner {
  kind: "user" | "system";
  tenantId: string | null;
  userId: string | null;
  username?: string | null;
  realName?: string | null;
}

export interface SandboxRecord {
  name: string;
  workspaceId?: string;
  sandboxScopeId?: string;
  sessionId?: string;
  phase?: string;
  createdAt?: string;
  lastActiveAt?: string;
  image?: string;
  busy?: boolean;
  imageStale?: boolean;
  idleMs?: number;
  ttlRemainingMs?: number;
  effectiveTtlMs?: number;
  brokenReason?: string;
  owner?: SandboxOwner;
  conditions?: unknown[];
  raw?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface OverviewAttentionEntityRef {
  kind: "run" | "session" | "sandbox" | "user" | "tenant";
  id: string;
}

export interface OverviewAttentionItem {
  kind: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  title: string;
  entityRef?: OverviewAttentionEntityRef;
  occurredAt?: string | null;
  actions?: string[];
}

export interface OverviewSnapshot {
  generatedAt: string;
  health: {
    activeRuns: { total: number; byStatus: Record<string, number> };
    sandboxes: { total: number; running: number; paused: number; broken: number };
    todayCostYuan: number;
    todayRuns: number;
    completionRate24h: number | null;
    toolRouting24h: {
      total: number;
      acsCount: number;
      localCount: number;
      failedCount: number;
    } | null;
    dispatch: Record<string, unknown> | null;
    sessionMetaProjection: {
      attempted?: number;
      succeeded?: number;
      failed?: number;
      lastError?: string;
      [key: string]: unknown;
    } | null;
    handFailures1h: number;
    storage: StorageHealth | null;
  };
  attention: OverviewAttentionItem[];
}

export interface StorageHealth {
  rootDisk: { usedPct: number; usedBytes: number; totalBytes: number; sampledAt: string } | null;
  nasUsedBytes: number | null;
  pgTopTables: Array<{ table: string; bytes: number; sampledAt: string }>;
  workspace: { totalBytes: number; orphanCount: number; orphanBytes: number; lastScanAt: string | null } | null;
  tlsCertDaysLeft: number | null;
}

export interface SystemMetricRecord {
  id: number;
  metric: string;
  label: string;
  valueNum: number;
  detailJson: Record<string, unknown> | null;
  sampledAt: string;
}

export interface SystemMetricsResponse {
  available: boolean;
  latest: SystemMetricRecord[];
  series: SystemMetricRecord[];
  generatedAt: string;
}

export type WorkspaceUsageStatus = "active" | "soft_deleted" | "orphan_tenant" | "orphan_user";

export interface WorkspaceUsageRecord {
  path: string;
  tenantId: string;
  userId: string | null;
  username: string | null;
  realName: string | null;
  status: WorkspaceUsageStatus;
  bytes: number;
  fileCount: number | null;
  scannedAt: string;
  archivedAt: string | null;
}

export interface SystemStorageResponse {
  available: boolean;
  summary: {
    totalBytes: number;
    orphanBytes: number;
    orphanCount: number;
    byTenant: Array<{ tenantId: string; bytes: number; workspaceCount: number }>;
    lastScanAt: string | null;
  };
  workspaces: WorkspaceUsageRecord[];
  orphans: WorkspaceUsageRecord[];
  generatedAt: string;
}

export interface AlertingStatus {
  configured: boolean;
  webhookConfigured: boolean;
  webhookMasked: string | null;
  minSeverity: "critical" | "high" | "medium" | "low" | "info";
  lastNotifiedAt: string | null;
  notifyCount: number;
}

export interface UserSummaryResponse {
  user: UserInfo;
  sessions30d: number;
  runs30d: { byStatus: Record<string, number>; total: number; lastActiveAt: string | null };
  costYuan30d: number;
  costYuanTotal: number;
  lastActiveAt: string | null;
  sandboxes: SandboxRecord[];
}

export interface SessionDetailResponse {
  session: PlatformSessionRecord;
  runs: PlatformRunRecord[];
  billing: {
    totalCostUsd?: number;
    totalCostYuan?: number;
    requestCount?: number;
    [key: string]: unknown;
  } | null;
  sandboxes: SandboxRecord[];
}

export interface RuntimeOperationsResponse {
  generatedAt: string;
  processRole: string | null;
  tenantRemoteHands: {
    hands: Array<Record<string, unknown>>;
    health: Array<{
      id: string;
      status: "ok" | "unhealthy";
      detail?: string;
      metadata?: {
        status?: string;
        backend?: string;
        image?: string;
        lifecycle?: {
          enabled?: boolean;
          cleanupIntervalMs?: number;
          idlePauseMs?: number;
          ttlMs?: number;
          orphanGraceMs?: number;
          drainDeadlineMs?: number;
          maxRunningSandboxes?: number;
          warnRunningSandboxes?: number;
        };
        sandboxes?: {
          totalCount?: number;
          runningCount?: number;
          pausedCount?: number;
          phaseCounts?: Record<string, number>;
          oldestCreatedAt?: string;
          newestLastActiveAt?: string;
        };
        snat?: SnatStatus;
        networkPolicy?: Record<string, unknown>;
      };
    }>;
  };
  runtimeEventStore: Record<string, unknown>;
}

export interface SnatEntry {
  id: string;
  name: string;
  sourceCidr: string;
  snatIp: string;
  status?: string;
  managed: boolean;
}

export interface SnatStatus {
  enabled: boolean;
  mode: string;
  configured: boolean;
  regionId?: string;
  snatTableId?: string;
  snatIp?: string;
  entryNamePrefix: string;
  maxManagedEntries: number;
  managedCount: number;
  unexpectedCount: number;
  orphanCount: number;
  entries: SnatEntry[];
  error?: string;
}
