import type { AppConfig } from '../app/config.js';
import type { BillingService } from '../data/billing/service.js';
import type { SecretVault } from '../security/secretVault.js';
import { parseWorkspaceId } from './workspaceIdentity.js';
import type { PgEventStore } from './pgEventStore.js';
import type { PgRunStore, RunStatus } from './runStore.js';
import type { PgSystemMetricsStore } from './systemMetricsStore.js';
import { requestAcsOrchestrator } from '../routes/runtimeOperationsAdmin.js';

export const ACTIVE_RUN_STATUSES = ['pending', 'running', 'waiting_approval', 'waiting_user', 'waiting_hand'] as const;

export type AttentionSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface AttentionItem {
  kind: string;
  severity: AttentionSeverity;
  title: string;
  entityRef?: { kind: 'run' | 'session' | 'sandbox' | 'user' | 'tenant'; id: string };
  occurredAt?: string | null;
  actions?: string[];
}

export interface SandboxSummary {
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
  owner?: { kind: 'user'; tenantId: string; userId: string } | { kind: 'system'; tenantId: null; userId: null };
  raw: Record<string, unknown>;
}

export interface AttentionBuildOptions {
  runStore?: PgRunStore;
  eventStore?: PgEventStore;
  systemMetricsStore?: PgSystemMetricsStore;
  billingService?: BillingService;
  dailyCostThresholdYuan?: number;
}

export async function buildRunAttention(options: Pick<AttentionBuildOptions, 'runStore'>): Promise<AttentionItem[]> {
  if (!options.runStore) return [];
  const [failed, stale] = await Promise.all([
    options.runStore.pool.query<Record<string, unknown>>(
      `SELECT run_id, session_id, tenant_id, user_id, status_reason, failed_at, updated_at
       FROM ${options.runStore.runsTable}
       WHERE status = 'failed'
         AND updated_at >= now() - interval '24 hours'
       ORDER BY updated_at DESC
       LIMIT 20`,
    ),
    options.runStore.pool.query<Record<string, unknown>>(
      `SELECT run_id, session_id, tenant_id, user_id, status, status_reason, updated_at
       FROM ${options.runStore.runsTable}
       WHERE status = ANY($1::text[])
         AND updated_at < now() - interval '15 minutes'
       ORDER BY updated_at ASC
       LIMIT 20`,
      [ACTIVE_RUN_STATUSES],
    ),
  ]);
  return [
    ...failed.rows.map((row) => ({
      kind: 'failed_run',
      severity: 'high' as const,
      title: `Run failed: ${row.status_reason ?? row.run_id}`,
      entityRef: { kind: 'run' as const, id: String(row.run_id) },
      occurredAt: toIsoOrNull((row.failed_at ?? row.updated_at) as Date | string | null),
      actions: ['view_trace'],
    })),
    ...stale.rows.map((row) => ({
      kind: 'stale_run',
      severity: 'medium' as const,
      title: `Stale ${row.status} run`,
      entityRef: { kind: 'run' as const, id: String(row.run_id) },
      occurredAt: toIsoOrNull(row.updated_at as Date | string | null),
      actions: ['view_trace'],
    })),
  ];
}

export async function queryHandFailures1h(options: Pick<AttentionBuildOptions, 'eventStore'>): Promise<Array<Record<string, any>>> {
  if (!options.eventStore) return [];
  const result = await options.eventStore.pool.query<Record<string, any>>(
    `SELECT timestamp, tenant_id, session_id, run_id,
            COALESCE(event_json->>'reason', event_json->>'message', event_json->>'error') AS reason
     FROM ${options.eventStore.eventsTable}
     WHERE event_type = 'hand_failure'
       AND timestamp >= now() - interval '1 hour'
     ORDER BY timestamp DESC
     LIMIT 20`,
  );
  return result.rows;
}

export function buildHandFailureAttention(rows: Array<Record<string, any>>): AttentionItem[] {
  return rows.map((item) => ({
    kind: 'hand_failure',
    severity: 'high',
    title: item.reason || 'hand_failure',
    entityRef: item.run_id
      ? { kind: 'run', id: String(item.run_id) }
      : { kind: 'session', id: String(item.session_id ?? '') },
    occurredAt: toIsoOrNull(item.timestamp),
    actions: ['view_session'],
  }));
}

export function buildSandboxAttention(sandboxes: SandboxSummary[]): AttentionItem[] {
  const now = Date.now();
  const attention: AttentionItem[] = [];
  for (const sandbox of sandboxes) {
    if (sandbox.brokenReason) {
      attention.push({
        kind: 'broken_sandbox',
        severity: 'high',
        title: sandbox.brokenReason,
        entityRef: { kind: 'sandbox', id: sandbox.name },
        occurredAt: sandbox.lastActiveAt ?? sandbox.createdAt ?? null,
        actions: ['view_sandbox', 'delete_recreate'],
      });
    }
    const phase = String(sandbox.phase ?? '');
    const createdAtMs = sandbox.createdAt ? Date.parse(sandbox.createdAt) : NaN;
    if (phase && phase !== 'Running' && phase !== 'Paused' && Number.isFinite(createdAtMs) && now - createdAtMs > 5 * 60_000) {
      attention.push({
        kind: 'transient_sandbox',
        severity: 'medium',
        title: `Sandbox stuck in ${phase}`,
        entityRef: { kind: 'sandbox', id: sandbox.name },
        occurredAt: sandbox.createdAt ?? null,
        actions: ['view_sandbox', 'cleanup'],
      });
    }
  }
  return attention;
}

export async function buildStorageAttention(options: Pick<AttentionBuildOptions, 'systemMetricsStore'>): Promise<AttentionItem[]> {
  const store = options.systemMetricsStore;
  if (!store) return [];
  const [rootDisk, workspaceScan, storageSummary, latestMetrics] = await Promise.all([
    store.getLatestMetric('disk_root'),
    store.getLatestMetric('workspace_scan'),
    store.getWorkspaceStorageSummary(),
    store.listLatestMetrics(),
  ]);
  const attention: AttentionItem[] = [];
  const usedPct = rootDisk?.valueNum ?? null;
  if (usedPct != null && Number.isFinite(usedPct) && usedPct >= 80) {
    attention.push({
      kind: 'disk_root_high',
      severity: usedPct >= 90 ? 'critical' : 'high',
      title: `Root disk usage ${usedPct.toFixed(1)}%`,
      occurredAt: rootDisk?.sampledAt ?? null,
      actions: ['ssh_cleanup'],
    });
  }
  const scanAt = workspaceScan?.sampledAt ? Date.parse(workspaceScan.sampledAt) : NaN;
  if (!Number.isFinite(scanAt) || Date.now() - scanAt > 48 * 60 * 60_000) {
    attention.push({
      kind: 'workspace_scan_stale',
      severity: 'medium',
      title: 'Workspace scan is stale',
      occurredAt: workspaceScan?.sampledAt ?? null,
      actions: ['open_infra', 'trigger_scan'],
    });
  }
  if (storageSummary.orphanCount > 0) {
    const severe = storageSummary.orphanBytes > 10 * 1024 ** 3 || storageSummary.orphanCount > 20;
    attention.push({
      kind: 'orphan_workspace',
      severity: severe ? 'high' : 'medium',
      title: `${storageSummary.orphanCount} orphan workspaces`,
      occurredAt: storageSummary.lastScanAt,
      actions: ['open_infra'],
    });
  }
  const tlsRows = latestMetrics.filter((metric) => metric.metric === 'tls_cert_expiry');
  for (const row of tlsRows) {
    const daysLeft = row.valueNum / 86_400;
    if (daysLeft < 14) {
      attention.push({
        kind: 'tls_cert_expiring',
        severity: daysLeft < 7 ? 'critical' : 'high',
        title: `${row.label || 'TLS certificate'} expires in ${Math.max(0, daysLeft).toFixed(1)} days`,
        occurredAt: row.sampledAt,
        actions: ['renew_cert'],
      });
    }
  }
  return attention;
}

export async function buildCostAttention(options: Pick<AttentionBuildOptions, 'billingService' | 'dailyCostThresholdYuan'>): Promise<AttentionItem[]> {
  const threshold = options.dailyCostThresholdYuan;
  const store = options.billingService?.store;
  if (!store || !threshold || threshold <= 0) return [];
  const result = await store.pool.query<{ cost: string }>(
    `SELECT COALESCE(sum(actual_cost_yuan_micro),0)::text AS cost
     FROM ${store.usageEventsTable}
     WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')`,
  );
  const todayCostYuan = Number(result.rows[0]?.cost ?? 0) / 1_000_000;
  if (todayCostYuan <= threshold) return [];
  return [{
    kind: 'cost_daily_high',
    severity: 'high',
    title: `Today cost ¥${todayCostYuan.toFixed(2)} exceeds threshold ¥${threshold.toFixed(2)}`,
    occurredAt: new Date().toISOString(),
    actions: ['open_efficiency'],
  }];
}

export async function buildAttentionQueue(options: AttentionBuildOptions & {
  sandboxes?: SandboxSummary[];
  handFailures?: Array<Record<string, any>>;
}): Promise<AttentionItem[]> {
  const [runAttention, storageAttention, costAttention] = await Promise.all([
    buildRunAttention(options),
    buildStorageAttention(options),
    buildCostAttention(options),
  ]);
  const sandboxAttention = buildSandboxAttention(options.sandboxes ?? []);
  const handAttention = buildHandFailureAttention(options.handFailures ?? await queryHandFailures1h(options));
  return [
    ...runAttention,
    ...sandboxAttention,
    ...handAttention,
    ...storageAttention,
    ...costAttention,
  ].slice(0, 50);
}

export async function fetchSandboxSummaries(options: {
  config: AppConfig;
  secretVault?: SecretVault;
  fetchImpl?: typeof fetch;
  acsTimeoutMs?: number;
}): Promise<SandboxSummary[]> {
  const result = await requestAcsOrchestrator({
    config: options.config,
    secretVault: options.secretVault,
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs: options.acsTimeoutMs ?? 5_000,
    path: '/sandboxes',
    method: 'GET',
  });
  if (result.status < 200 || result.status >= 300) return [];
  const body = result.body as { sandboxes?: unknown };
  if (!Array.isArray(body.sandboxes)) return [];
  return body.sandboxes
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => {
      const workspaceId = typeof item.workspaceId === 'string' ? item.workspaceId : undefined;
      const owner = parseWorkspaceId(workspaceId);
      return {
        name: typeof item.name === 'string' ? item.name : '',
        workspaceId,
        sandboxScopeId: typeof item.sandboxScopeId === 'string' ? item.sandboxScopeId : undefined,
        sessionId: typeof item.sessionId === 'string' ? item.sessionId : undefined,
        phase: typeof item.phase === 'string' ? item.phase : undefined,
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : undefined,
        lastActiveAt: typeof item.lastActiveAt === 'string' ? item.lastActiveAt : undefined,
        image: typeof item.image === 'string' ? item.image : undefined,
        busy: typeof item.busy === 'boolean' ? item.busy : undefined,
        imageStale: typeof item.imageStale === 'boolean' ? item.imageStale : undefined,
        idleMs: typeof item.idleMs === 'number' ? item.idleMs : undefined,
        ttlRemainingMs: typeof item.ttlRemainingMs === 'number' ? item.ttlRemainingMs : undefined,
        effectiveTtlMs: typeof item.effectiveTtlMs === 'number' ? item.effectiveTtlMs : undefined,
        brokenReason: typeof item.brokenReason === 'string' ? item.brokenReason : undefined,
        owner: owner
          ? { kind: 'user' as const, tenantId: owner.tenantId, userId: owner.userId }
          : { kind: 'system' as const, tenantId: null, userId: null },
        raw: item,
      };
    })
    .filter((item) => item.name);
}

export function isActiveRunStatus(status: RunStatus): boolean {
  return (ACTIVE_RUN_STATUSES as readonly string[]).includes(status);
}

function toIsoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
