import { z } from "zod";

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
} from "./types";
import type { UserInfo } from "@/components/UserManager/types";

type QueryValue = string | number | boolean | null | undefined;

const nullableNumberSchema = z.number().nullable();
const nullableStringSchema = z.string().nullable();
const eventStoreCapacityPointSchema = z.object({
  totalBytes: nullableNumberSchema,
  tableBytes: nullableNumberSchema,
  indexBytes: nullableNumberSchema,
  sampledAt: z.string(),
});
const eventStoreCapacitySchema = z.object({
  available: z.boolean(),
  tableName: nullableStringSchema,
  totalBytes: nullableNumberSchema,
  tableBytes: nullableNumberSchema,
  indexBytes: nullableNumberSchema,
  sampledAt: nullableStringSchema,
  stale: z.boolean(),
  series: z.array(eventStoreCapacityPointSchema),
}).refine(
  (capacity) => !capacity.available || (
    capacity.sampledAt !== null && hasCompleteCapacityValues(capacity)
    && capacity.series.every(hasCompleteCapacityValues)
  ),
  { message: "可用的 EventStore 容量必须包含完整的非负 table/index/total 字段" },
);
const eventStoreStatusSchema = z.object({
  schemaVersion: z.literal(1),
  available: z.boolean(),
  generatedAt: z.string(),
  retention: z.object({
    enabled: z.boolean(),
    mode: z.enum(["dry-run", "execute"]),
    status: z.enum(["never_run", "running", "dry_run_succeeded", "execute_succeeded", "blocked", "failed", "stale", "unavailable"]),
    stale: z.boolean(),
    lastStartedAt: nullableStringSchema,
    lastCompletedAt: nullableStringSchema,
    lastSuccessAt: nullableStringSchema,
    durationMs: nullableNumberSchema,
    errorCategory: nullableStringSchema,
    nextScheduledAt: nullableStringSchema,
    watermarks: z.object({
      legal: nullableStringSchema,
      billing: nullableStringSchema,
      effective: nullableStringSchema,
      maxGlobalSequence: nullableStringSchema,
      lag: nullableStringSchema,
    }),
    categories: z.record(z.string(), z.object({ eligible: nullableNumberSchema, deleted: nullableNumberSchema })),
  }),
  capacity: eventStoreCapacitySchema,
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

async function getJson<T>(path: string): Promise<T> {
  const res = await authFetch(path);
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
  search(q: string): Promise<{ matches: PlatformSearchMatch[] }> {
    return getJson(buildAdminApiPath("/search", { q }));
  },
  overviewSnapshot(): Promise<OverviewSnapshot> {
    return getJson(buildAdminApiPath("/overview/snapshot"));
  },
  overviewTrends(days = 14): Promise<PlatformTrendResponse> {
    return getJson(buildAdminApiPath("/overview/trends", { days }));
  },
  billingTrend(days = 14): Promise<BillingAuditTrendResponse> {
    return getJson(buildAdminApiPath("/billing/audit", { days }));
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
