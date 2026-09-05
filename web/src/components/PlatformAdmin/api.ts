import { z } from "zod";
import { parseConfigIdentitySummary } from "@agent/shared/schemas/configIdentity";
import type { ProviderQuotaHistoryResponse, ProviderQuotaOverviewResponse } from "@agent/shared";

import { authFetch } from "@/lib/authFetch";
import type {
  OverviewSnapshot,
  PagedResponse,
  PlatformRunRecord,
  PlatformSearchMatch,
  PlatformSessionRecord,
  PlatformTrendResponse,
  RuntimeOperationsResponse,
  RuntimeSchedulerConfigResponse,
  SandboxRecord,
  SessionDetailResponse,
  AlertingStatus,
  BillingAuditTrendResponse,
  EventStoreStatusResponse,
  SystemMetricsResponse,
  SystemStorageResponse,
  TenantOverviewResponse,
  ToolInvocationAnalysisResponse,
  ToolInvocationStatus,
  UserSummaryResponse,
  EffectiveConfigStatus,
} from "./types";
import type { UserInfo } from "@/components/UserManager/types";

type QueryValue = string | number | boolean | null | undefined;

const nullableNumberSchema = z.number().nullable();
const nonnegativeNumberSchema = z.number().nonnegative();
const nonnegativeIntegerSchema = z.number().int().nonnegative();
const nullableStringSchema = z.string().nullable();
const isoTimestampSchema = z.string().datetime({ offset: true });

const overviewStorageSchema = z.object({
  rootDisk: z.object({
    usedPct: z.number().min(0).max(100),
    usedBytes: nonnegativeIntegerSchema,
    totalBytes: nonnegativeIntegerSchema,
    sampledAt: isoTimestampSchema,
  }).nullable(),
  nasUsedBytes: nonnegativeIntegerSchema.nullable(),
  pgTopTables: z.array(z.object({
    table: z.string(),
    bytes: nonnegativeIntegerSchema,
    sampledAt: isoTimestampSchema,
  })),
  workspace: z.object({
    totalBytes: nonnegativeIntegerSchema,
    orphanCount: nonnegativeIntegerSchema,
    orphanBytes: nonnegativeIntegerSchema,
    lastScanAt: isoTimestampSchema.nullable(),
  }).nullable(),
  tlsCertDaysLeft: nullableNumberSchema,
});

const overviewSnapshotSchema = z.object({
  generatedAt: isoTimestampSchema,
  health: z.object({
    activeRuns: z.object({
      total: nonnegativeIntegerSchema,
      byStatus: z.record(z.string(), nonnegativeIntegerSchema),
    }),
    sandboxes: z.object({
      total: nonnegativeIntegerSchema,
      running: nonnegativeIntegerSchema,
      paused: nonnegativeIntegerSchema,
      broken: nonnegativeIntegerSchema,
    }),
    todayCostYuan: nonnegativeNumberSchema,
    todayRuns: nonnegativeIntegerSchema,
    completionRateToday: z.number().min(0).max(1).nullable(),
    toolRouting24h: z.object({
      total: nonnegativeIntegerSchema,
      acsCount: nonnegativeIntegerSchema,
      localCount: nonnegativeIntegerSchema,
      failedCount: nonnegativeIntegerSchema,
    }).nullable(),
    dispatch: z.object({
      totalRuns: nonnegativeIntegerSchema,
      totalErrors: nonnegativeIntegerSchema,
      avgDurationMs: nonnegativeNumberSchema,
      avgFirstEventLatencyMs: nonnegativeNumberSchema.nullable(),
      byChannel: z.record(z.string(), z.object({
        runs: nonnegativeIntegerSchema,
        errors: nonnegativeIntegerSchema,
      })),
      lastRun: z.record(z.string(), z.unknown()).optional(),
    }).nullable(),
    sessionMetaProjection: z.object({
      failures: nonnegativeIntegerSchema,
      pending: nonnegativeIntegerSchema,
      lastError: z.string().optional(),
    }).nullable(),
    handFailures1h: nonnegativeIntegerSchema,
    storage: overviewStorageSchema.nullable(),
  }),
  configIdentity: z.unknown().optional().nullable(),
  attention: z.array(z.object({
    kind: z.string(),
    severity: z.enum(["critical", "high", "medium", "low", "info"]),
    title: z.string(),
    entityRef: z.object({
      kind: z.enum(["run", "session", "sandbox", "user", "tenant"]),
      id: z.string(),
    }).optional(),
    occurredAt: z.string().nullable().optional(),
    actions: z.array(z.string()).optional(),
  })),
});

const eventStoreCapacityPointSchema = z.object({
  totalBytes: nullableNumberSchema,
  tableBytes: nullableNumberSchema,
  indexBytes: nullableNumberSchema,
  sampledAt: isoTimestampSchema,
});
const eventStoreCapacitySchema = z.object({
  available: z.boolean(),
  tableName: nullableStringSchema,
  totalBytes: nullableNumberSchema,
  tableBytes: nullableNumberSchema,
  indexBytes: nullableNumberSchema,
  sampledAt: isoTimestampSchema.nullable(),
  stale: z.boolean(),
  series: z.array(eventStoreCapacityPointSchema),
}).refine(
  (capacity) => !capacity.available || (
    capacity.sampledAt !== null && hasCompleteCapacityValues(capacity)
    && capacity.series.every(hasCompleteCapacityValues)
  ),
  { message: "可用的 EventStore 容量必须包含完整的非负 table/index/total 字段" },
);
const digitStringSchema = z.string().regex(/^\d+$/);
const retentionCategoryNames = [
  "tool-delta",
  "assistant-stream",
  "tool-stream-summary",
  "model-diagnostics",
  "model-request-finished",
  "hand-events",
] as const;
const retentionErrorCategorySchema = z.enum([
  "authorization_missing",
  "legal_watermark_invalid",
  "status_persistence_unavailable",
  "partial_failure",
  "execution_failed",
]).nullable();
// 运行结果与 freshness 正交；过期只能由 stale 布尔值表达。
// persisted never_run 可携带当前配置的 legal watermark；无持久快照时该字段为 null。
const eventStoreRetentionSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(["dry-run", "execute"]),
  status: z.enum(["never_run", "scheduled", "running", "dry_run_succeeded", "execute_succeeded", "blocked", "failed", "unavailable"]),
  stale: z.boolean(),
  lastStartedAt: isoTimestampSchema.nullable(),
  lastCompletedAt: isoTimestampSchema.nullable(),
  lastSuccessAt: isoTimestampSchema.nullable(),
  durationMs: z.number().nonnegative().nullable(),
  errorCategory: retentionErrorCategorySchema,
  nextScheduledAt: isoTimestampSchema.nullable(),
  watermarks: z.object({
    legal: digitStringSchema.nullable(),
    billing: digitStringSchema.nullable(),
    effective: digitStringSchema.nullable(),
    maxGlobalSequence: digitStringSchema.nullable(),
    lag: digitStringSchema.nullable(),
  }),
  categories: z.record(z.string(), z.object({
    eligible: z.number().int().nonnegative().nullable(),
    deleted: z.number().int().nonnegative().nullable(),
  })),
}).superRefine((retention, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  const categories = Object.values(retention.categories);
  const hasNoProgress = categories.length === 0
    && retention.watermarks.billing === null && retention.watermarks.effective === null
    && retention.watermarks.maxGlobalSequence === null && retention.watermarks.lag === null;
  if (categories.some((category) => (
    category.eligible !== null && category.deleted !== null && category.deleted > category.eligible
  ))) issue("retention 分类删除量不能超过符合条件量");
  if (retention.status === "scheduled") {
    if (!retention.enabled || retention.nextScheduledAt === null
      || retention.lastStartedAt !== null || retention.lastCompletedAt !== null
      || retention.durationMs !== null || retention.errorCategory !== null
      || retention.watermarks.legal === null || !hasNoProgress) {
      issue("scheduled retention 状态字段不完整");
    }
    return;
  }
  if (retention.status === "never_run") {
    if (retention.lastStartedAt !== null || retention.lastCompletedAt !== null
      || retention.lastSuccessAt !== null || retention.durationMs !== null
      || retention.errorCategory !== null || retention.nextScheduledAt !== null
      || !hasNoProgress) {
      issue("never_run retention 状态字段不完整");
    }
    return;
  }
  if (retention.status === "running") {
    if (retention.lastStartedAt === null || retention.lastCompletedAt !== null
      || retention.durationMs !== null || retention.errorCategory !== null
      || retention.watermarks.legal === null || !hasNoProgress) {
      issue("running retention 状态字段不完整");
    }
    return;
  }
  if (retention.status === "dry_run_succeeded" || retention.status === "execute_succeeded") {
    const completeCategories = categories.length === retentionCategoryNames.length
      && retentionCategoryNames.every((name) => retention.categories[name] !== undefined)
      && categories.every((category) => category.eligible !== null && category.deleted !== null);
    const dryRunDeletedNothing = retention.status !== "dry_run_succeeded"
      || categories.every((category) => category.deleted === 0);
    const ordered = retention.lastStartedAt !== null && retention.lastCompletedAt !== null
      && Date.parse(retention.lastCompletedAt) >= Date.parse(retention.lastStartedAt)
      && retention.lastSuccessAt !== null
      && Date.parse(retention.lastSuccessAt) >= Date.parse(retention.lastStartedAt);
    if (!ordered || retention.durationMs === null || retention.errorCategory !== null
      || retention.watermarks.legal === null || retention.watermarks.billing === null
      || retention.watermarks.effective === null || retention.watermarks.maxGlobalSequence === null
      || retention.watermarks.lag === null || !hasConsistentRetentionWatermarks(retention.watermarks)
      || !completeCategories || !dryRunDeletedNothing
      || (retention.enabled && retention.nextScheduledAt === null)
      || (retention.status === "dry_run_succeeded") !== (retention.mode === "dry-run")) {
      issue("成功 retention 状态字段不完整或语义非法");
    }
    return;
  }
  if (retention.status === "blocked" || retention.status === "failed") {
    const ordered = retention.lastStartedAt !== null && retention.lastCompletedAt !== null
      && Date.parse(retention.lastCompletedAt) >= Date.parse(retention.lastStartedAt);
    if (!ordered || retention.durationMs === null || !retention.errorCategory?.trim()
      || (retention.enabled && retention.nextScheduledAt === null)) {
      issue("失败 retention 状态字段不完整");
    }
  }
});

function hasConsistentRetentionWatermarks(watermarks: {
  legal: string | null;
  billing: string | null;
  effective: string | null;
  maxGlobalSequence: string | null;
  lag: string | null;
}): boolean {
  if (watermarks.legal === null || watermarks.billing === null || watermarks.effective === null
    || watermarks.maxGlobalSequence === null || watermarks.lag === null) return false;
  if (![watermarks.legal, watermarks.billing, watermarks.effective, watermarks.maxGlobalSequence, watermarks.lag]
    .every((value) => /^\d+$/.test(value))) return false;
  const legal = BigInt(watermarks.legal);
  const billing = BigInt(watermarks.billing);
  const effective = BigInt(watermarks.effective);
  const maxGlobalSequence = BigInt(watermarks.maxGlobalSequence);
  const lag = BigInt(watermarks.lag);
  const expectedLag = maxGlobalSequence > effective ? maxGlobalSequence - effective : 0n;
  return effective === (legal < billing ? legal : billing) && lag === expectedLag;
}

// 响应生成、运行与容量时间共享 5 分钟时钟偏差门禁。
const eventStoreStatusSchema = z.object({
  schemaVersion: z.literal(1),
  available: z.boolean(),
  generatedAt: isoTimestampSchema,
  retention: eventStoreRetentionSchema,
  capacity: eventStoreCapacitySchema,
}).superRefine((status, ctx) => {
  const generatedAtMs = Date.parse(status.generatedAt);
  const latestRunTimestamp = generatedAtMs + 5 * 60_000;
  if (generatedAtMs > Date.now() + 5 * 60_000) {
    ctx.addIssue({ code: "custom", message: "EventStore 响应生成时间不能明显晚于客户端时间" });
  }
  const runTimestamps = [
    status.retention.lastStartedAt,
    status.retention.lastCompletedAt,
    status.retention.lastSuccessAt,
  ];
  if (runTimestamps.some((value) => value !== null && Date.parse(value) > latestRunTimestamp)) {
    ctx.addIssue({ code: "custom", message: "retention 运行时间不能晚于响应生成时间" });
  }
  const capacityTimestamps = [
    status.capacity.sampledAt,
    ...status.capacity.series.map((point) => point.sampledAt),
  ];
  if (capacityTimestamps.some((value) => value !== null && Date.parse(value) > latestRunTimestamp)) {
    ctx.addIssue({ code: "custom", message: "EventStore 容量采样时间不能晚于响应生成时间" });
  }
});

function hasCompleteCapacityValues(capacity: {
  totalBytes: number | null;
  tableBytes: number | null;
  indexBytes: number | null;
}): boolean {
  const values = [capacity.totalBytes, capacity.tableBytes, capacity.indexBytes];
  return values.every((value) => value !== null && Number.isFinite(value) && value >= 0)
    && capacity.totalBytes! >= capacity.tableBytes! + capacity.indexBytes!;
}

export function buildAdminApiPath(path: string, query: Record<string, QueryValue> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === "") continue;
    params.set(key, String(value));
  }
  const s = params.toString();
  return `/api/admin${path}${s ? `?${s}` : ""}`;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await authFetch(path, { signal });
  const text = await res.text();
  const body = text
    ? safeParseJson<T & { error?: string }>(text, {} as T & { error?: string })
    : {} as T & { error?: string };
  if (!res.ok) {
    throw new Error(body.error || text.slice(0, 200) || `${path} → HTTP ${res.status}`);
  }
  return body as T;
}

async function mutateJson<T>(path: string, method: "POST" | "DELETE" | "PATCH", body?: unknown): Promise<T> {
  const res = await authFetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text
    ? safeParseJson<T & { error?: string }>(text, {} as T & { error?: string })
    : {} as T & { error?: string };
  if (!res.ok) throw new Error(data.error || text.slice(0, 200) || `${path} → HTTP ${res.status}`);
  return data as T;
}

function safeParseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export const platformAdminApi = {
  configStatus(): Promise<EffectiveConfigStatus> {
    return getJson("/api/admin/config-status");
  },
  providerQuota(): Promise<ProviderQuotaOverviewResponse> {
    return getJson(buildAdminApiPath("/provider-quota"));
  },
  providerQuotaHistory(hours = 24): Promise<ProviderQuotaHistoryResponse> {
    return getJson(buildAdminApiPath("/provider-quota/history", { hours }));
  },
  refreshProviderQuota(accountKey?: string): Promise<ProviderQuotaOverviewResponse> {
    return mutateJson(buildAdminApiPath("/provider-quota/refresh", { accountKey }), "POST");
  },
  search(q: string): Promise<{ matches: PlatformSearchMatch[] }> {
    return getJson(buildAdminApiPath("/search", { q }));
  },
  async overviewSnapshot(signal?: AbortSignal): Promise<OverviewSnapshot> {
    const response = await getJson<unknown>(buildAdminApiPath("/overview/snapshot"), signal);
    const parsed = overviewSnapshotSchema.safeParse(response);
    if (!parsed.success) throw new Error("平台总览响应无效");
    return {
      ...parsed.data,
      configIdentity: parseConfigIdentitySummary(parsed.data.configIdentity),
    };
  },
  overviewTrends(days = 14, signal?: AbortSignal): Promise<PlatformTrendResponse> {
    return getJson(buildAdminApiPath("/overview/trends", { days }), signal);
  },
  billingTrend(days = 14, signal?: AbortSignal): Promise<BillingAuditTrendResponse> {
    return getJson(buildAdminApiPath("/billing/audit", { days }), signal);
  },
  tenantOverview(tenantId?: string): Promise<TenantOverviewResponse> {
    return getJson(buildAdminApiPath("/tenants/overview", { tenantId }));
  },
  users(query: { tenantId?: string; q?: string; cursor?: string; limit?: number } = {}): Promise<PagedResponse<UserInfo>> {
    return getJson(buildAdminApiPath("/users", query));
  },
  userSummary(id: string): Promise<UserSummaryResponse> {
    return getJson(buildAdminApiPath(`/users/${encodeURIComponent(id)}/summary`));
  },
  sessions(query: {
    tenantId?: string;
    userId?: string;
    q?: string;
    status?: string;
    kind?: "user" | "subagent";
    model?: string;
    channel?: string;
    updatedFrom?: string;
    updatedTo?: string;
    includeDeleted?: boolean;
    cursor?: string;
    limit?: number;
  } = {}): Promise<PagedResponse<PlatformSessionRecord>> {
    return getJson(buildAdminApiPath("/sessions", query));
  },
  sessionDetail(id: string): Promise<SessionDetailResponse> {
    return getJson(buildAdminApiPath(`/sessions/${encodeURIComponent(id)}`));
  },
  runs(query: {
    tenantId?: string;
    userId?: string;
    sessionId?: string;
    status?: string;
    reasonContains?: string;
    hours?: number;
    cursor?: string;
    limit?: number;
  } = {}): Promise<PagedResponse<PlatformRunRecord>> {
    return getJson(buildAdminApiPath("/runs", query));
  },
  toolInvocations(query: {
    tenantId?: string;
    userId?: string;
    toolName?: string;
    skillName?: string;
    status?: ToolInvocationStatus;
    reasonContains?: string;
    hours?: number;
    limit?: number;
    offset?: number;
  } = {}): Promise<ToolInvocationAnalysisResponse> {
    return getJson(buildAdminApiPath("/tool-invocations", query));
  },
  runtimeOperations(): Promise<RuntimeOperationsResponse> {
    return getJson("/api/admin/runtime-operations");
  },
  schedulerRuntimeConfig(): Promise<RuntimeSchedulerConfigResponse> {
    return getJson("/api/admin/runtime-operations/scheduler/runtime-config");
  },
  updateSchedulerRuntimeConfig(maxConcurrentRuns: number): Promise<RuntimeSchedulerConfigResponse> {
    return mutateJson("/api/admin/runtime-operations/scheduler/runtime-config", "PATCH", { maxConcurrentRuns });
  },
  sandboxes(): Promise<{ sandboxes: SandboxRecord[] }> {
    return getJson("/api/admin/runtime-operations/acs/sandboxes");
  },
  async sandbox(name: string): Promise<SandboxRecord> {
    const body = await getJson<{
      status?: string;
      name?: string;
      phase?: string | null;
      brokenReason?: string | null;
      sandbox?: Record<string, unknown>;
    }>(`/api/admin/runtime-operations/acs/sandboxes/${encodeURIComponent(name)}`);
    return {
      ...(body.sandbox ?? {}),
      name: body.name ?? name,
      phase: body.phase ?? undefined,
      brokenReason: body.brokenReason ?? undefined,
      raw: body.sandbox ?? body,
    } as SandboxRecord;
  },
  pauseSandbox(name: string): Promise<unknown> {
    return mutateJson(`/api/admin/runtime-operations/acs/sandboxes/${encodeURIComponent(name)}/pause`, "POST", {});
  },
  resumeSandbox(name: string): Promise<unknown> {
    return mutateJson(`/api/admin/runtime-operations/acs/sandboxes/${encodeURIComponent(name)}/resume`, "POST", {});
  },
  deleteSandbox(name: string): Promise<unknown> {
    return mutateJson(`/api/admin/runtime-operations/acs/sandboxes/${encodeURIComponent(name)}`, "DELETE");
  },
  cleanupLifecycle(): Promise<unknown> {
    return mutateJson("/api/admin/runtime-operations/acs/lifecycle-cleanup", "POST", {});
  },
  probeNetworkPolicy(): Promise<unknown> {
    return mutateJson("/api/admin/runtime-operations/acs/network-policy/probe", "POST", {});
  },
  cleanupOrphanSnat(): Promise<unknown> {
    return mutateJson("/api/admin/runtime-operations/acs/snat/cleanup-orphans", "POST", {});
  },
  systemMetrics(query: { hours?: number } = {}): Promise<SystemMetricsResponse> {
    return getJson(buildAdminApiPath("/system/metrics", query));
  },
  async eventStoreStatus(query: { hours?: number } = {}): Promise<EventStoreStatusResponse> {
    const response = await getJson<unknown>(buildAdminApiPath("/system/event-store", query));
    const parsed = eventStoreStatusSchema.safeParse(response);
    if (!parsed.success) throw new Error("EventStore 状态响应无效");
    return parsed.data;
  },
  systemStorage(): Promise<SystemStorageResponse> {
    return getJson(buildAdminApiPath("/system/storage"));
  },
  triggerStorageScan(): Promise<{ ok: boolean; result: { dirs: number; orphans: number; totalBytes: number; durationMs: number } }> {
    return mutateJson(buildAdminApiPath("/system/storage/scan"), "POST", {});
  },
  archiveWorkspace(path: string, confirm: string): Promise<{ ok: boolean; result: { relativeArchivePath: string } }> {
    return mutateJson(buildAdminApiPath("/system/storage/archive"), "POST", { path, confirm });
  },
  deleteWorkspace(path: string, confirm: string): Promise<{ ok: boolean; result: { relativePath: string; bytes: number; fileCount: number | null } }> {
    return mutateJson(buildAdminApiPath("/system/storage/delete"), "POST", { path, confirm });
  },
  alertingStatus(): Promise<AlertingStatus> {
    return getJson(buildAdminApiPath("/system/alerts/status"));
  },
  sendTestAlert(): Promise<{ ok: boolean }> {
    return mutateJson(buildAdminApiPath("/system/alerts/test"), "POST", {});
  },
};
