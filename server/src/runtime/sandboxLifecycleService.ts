import type { SandboxWorkloadDescriptor } from '@agent/shared';
import type { PlatformEvent } from './types.js';
import type { HandStore } from './handStore.js';
import type { RunStore } from './runStore.js';
import type { PgPool } from './runStoreTypes.js';
import { hasSandboxScopeActivity } from './runStoreSessionActivity.js';
import type { SessionCatalog } from './sessionCatalog.js';
import { deriveSandboxScopeId, deriveWorkspaceMountSubPath, type TenantRemoteHandDispatchConfig } from './rawRuntimeRunDispatch.js';
import { runtimeRunController } from './runController.js';
import { controlPlaneFetch } from './controlPlaneFetch.js';
import { selectTenantRemoteHandsForRegistration, type TenantRemoteHandAuthTokenResolver } from './tenantRemoteHandResolver.js';

export interface SandboxLifecycleIdentity {
  workspaceId: string;
  sessionId: string;
  sandboxScopeId: string;
}

interface LifecycleCandidate extends SandboxLifecycleIdentity {
  runId: string;
  tenantId?: string;
  status: 'completed' | 'failed' | 'cancelled' | 'orphaned';
  statusReason?: string;
  terminalAt: string;
  workload: SandboxWorkloadDescriptor;
}

interface CleanupCandidate extends SandboxLifecycleIdentity {
  runId: string;
  tenantId?: string;
}

interface ActiveScopeRun {
  runId: string;
  sessionId: string;
  tenantId?: string;
  userId?: string;
}

export interface SandboxLifecycleLogger {
  info(message: string): void;
  warn(message: string): void;
}

export class PgSandboxLifecycleStore {
  constructor(
    private readonly pool: PgPool,
    private readonly runsTable: string,
    private readonly steeringInputsTable: string,
  ) {}

  async listTerminalCandidates(limit = 100): Promise<LifecycleCandidate[]> {
    const result = await this.pool.query<Record<string, unknown>>(`
      SELECT run_id, session_id, tenant_id, workspace_id, sandbox_scope_id, status,
             status_reason, completed_at, failed_at, cancelled_at, updated_at, metadata
      FROM ${this.runsTable}
      WHERE status IN ('completed','failed','cancelled','orphaned')
        AND metadata->>'sandboxWorkloadTopLevel' = 'true'
        AND metadata->'sandboxWorkloadDescriptor'->>'kind' IN ('taskboard','cron','memory')
        AND COALESCE(metadata->'sandboxLifecycleOutbox'->>'state', 'pending') <> 'delivered'
        AND workspace_id IS NOT NULL AND sandbox_scope_id IS NOT NULL
      ORDER BY updated_at ASC
      LIMIT $1
    `, [limit]);
    return result.rows.flatMap((row) => {
      const metadata = asRecord(row.metadata);
      const workload = parseWorkload(metadata.sandboxWorkloadDescriptor);
      const status = row.status;
      if (!workload || workload.kind === 'interactive'
        || !['completed', 'failed', 'cancelled', 'orphaned'].includes(String(status))) return [];
      return [{
        runId: String(row.run_id), sessionId: String(row.session_id),
        ...(typeof row.tenant_id === 'string' ? { tenantId: row.tenant_id } : {}),
        workspaceId: String(row.workspace_id), sandboxScopeId: String(row.sandbox_scope_id),
        status: status as LifecycleCandidate['status'],
        ...(typeof row.status_reason === 'string' ? { statusReason: row.status_reason } : {}),
        terminalAt: String(row.completed_at ?? row.failed_at ?? row.cancelled_at ?? row.updated_at),
        workload,
      }];
    });
  }

  hasActivity(candidate: Pick<LifecycleCandidate, 'sandboxScopeId' | 'sessionId' | 'tenantId'>): Promise<boolean> {
    return hasSandboxScopeActivity({ pool: this.pool, runsTable: this.runsTable, steeringInputsTable: this.steeringInputsTable }, {
      sandboxScopeId: candidate.sandboxScopeId,
      topLevelSessionId: candidate.sessionId,
      ...(candidate.tenantId ? { tenantId: candidate.tenantId } : {}),
    });
  }

  async markTerminalDelivered(runId: string, deliveredAt: string): Promise<void> {
    await this.pool.query(`
      UPDATE ${this.runsTable}
      SET metadata = metadata || jsonb_build_object('sandboxLifecycleOutbox',
        jsonb_build_object('state','delivered','deliveredAt',$2::text)), updated_at=NOW()
      WHERE run_id=$1
    `, [runId, deliveredAt]);
  }

  async enqueueCleanup(candidate: Omit<CleanupCandidate, 'runId'>): Promise<string | undefined> {
    const payload = JSON.stringify({
      state: 'pending', workspaceId: candidate.workspaceId, sessionId: candidate.sessionId,
      sandboxScopeId: candidate.sandboxScopeId, queuedAt: new Date().toISOString(),
    });
    const result = await this.pool.query<{ run_id: string }>(`
      UPDATE ${this.runsTable}
      SET metadata = metadata || jsonb_build_object('sandboxCleanupOutbox', $3::jsonb), updated_at=NOW()
      WHERE run_id = (
        SELECT run_id FROM ${this.runsTable}
        WHERE session_id=$1 AND ($2::text IS NULL OR tenant_id=$2)
        ORDER BY (metadata->>'sandboxWorkloadTopLevel' = 'true') DESC, updated_at DESC
        LIMIT 1
      )
      RETURNING run_id
    `, [candidate.sessionId, candidate.tenantId ?? null, payload]);
    return result.rows[0]?.run_id;

  }

  async cancelCleanup(sessionId: string, tenantId?: string): Promise<void> {
    await this.pool.query(`
      UPDATE ${this.runsTable}
      SET metadata = jsonb_set(metadata, '{sandboxCleanupOutbox}',
        COALESCE(metadata->'sandboxCleanupOutbox','{}'::jsonb) || jsonb_build_object('state','cancelled','cancelledAt',$3::text)),
        updated_at=NOW()
      WHERE session_id=$1 AND ($2::text IS NULL OR tenant_id=$2)
        AND metadata->'sandboxCleanupOutbox'->>'state' = 'pending'
    `, [sessionId, tenantId ?? null, new Date().toISOString()]);
  }

  async listCleanupCandidates(limit = 100): Promise<CleanupCandidate[]> {
    const result = await this.pool.query<Record<string, unknown>>(`
      SELECT run_id, tenant_id, metadata->'sandboxCleanupOutbox' AS cleanup
      FROM ${this.runsTable}
      WHERE metadata->'sandboxCleanupOutbox'->>'state' = 'pending'
      ORDER BY updated_at ASC LIMIT $1
    `, [limit]);
    return result.rows.flatMap((row) => {
      const cleanup = asRecord(row.cleanup);
      if (!stringValue(cleanup.workspaceId) || !stringValue(cleanup.sessionId) || !stringValue(cleanup.sandboxScopeId)) return [];
      return [{
        runId: String(row.run_id), workspaceId: stringValue(cleanup.workspaceId)!,
        sessionId: stringValue(cleanup.sessionId)!, sandboxScopeId: stringValue(cleanup.sandboxScopeId)!,
        ...(typeof row.tenant_id === 'string' ? { tenantId: row.tenant_id } : {}),
      }];
    });
  }

  async markCleanupDelivered(runId: string, deliveredAt: string): Promise<void> {
    await this.pool.query(`
      UPDATE ${this.runsTable}
      SET metadata = jsonb_set(metadata, '{sandboxCleanupOutbox}',
        COALESCE(metadata->'sandboxCleanupOutbox','{}'::jsonb) || jsonb_build_object('state','delivered','deliveredAt',$2::text)),
        updated_at=NOW()
      WHERE run_id=$1
    `, [runId, deliveredAt]);
  }

  async listActiveScopeRuns(identity: SandboxLifecycleIdentity, tenantId?: string): Promise<ActiveScopeRun[]> {
    const result = await this.pool.query<Record<string, unknown>>(`
      SELECT run_id, session_id, tenant_id, user_id
      FROM ${this.runsTable}
      WHERE ($1::text = sandbox_scope_id OR session_id=$2 OR metadata->>'topLevelSessionId'=$2)
        AND ($3::text IS NULL OR tenant_id=$3)
        AND status IN ('pending','running','waiting_approval','waiting_user','waiting_hand')
      ORDER BY requested_at ASC
    `, [identity.sandboxScopeId, identity.sessionId, tenantId ?? null]);
    return result.rows.map((row) => ({
      runId: String(row.run_id), sessionId: String(row.session_id),
      ...(typeof row.tenant_id === 'string' ? { tenantId: row.tenant_id } : {}),
      ...(typeof row.user_id === 'string' ? { userId: row.user_id } : {}),
    }));
  }
}

export class AcsSandboxLifecycleClient {
  constructor(private readonly options: {
    baseUrl: string;
    authToken: string;
    fetchImpl?: typeof fetch;
    requestTimeoutMs?: number;
  }) {}

  async notifyTerminal(input: SandboxLifecycleIdentity & {
    terminalState: 'completed' | 'failed' | 'cancelled' | 'timed-out';
    terminalAt: string;
    outcome?: unknown;
  }): Promise<void> {
    await this.request('/sandboxes/lifecycle', 'POST', input);
  }

  async deleteScope(input: SandboxLifecycleIdentity): Promise<void> {
    await this.request('/sandboxes/scope', 'DELETE', input);
  }

  private async request(path: string, method: 'POST' | 'DELETE', body: unknown): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs ?? 5_000);
    timer.unref?.();
    try {
      const baseUrl = this.options.baseUrl.replace(/\/$/, '');
      const response = await controlPlaneFetch(baseUrl, this.options.fetchImpl)(`${baseUrl}${path}`, {
        method, headers: { 'content-type': 'application/json', authorization: `Bearer ${this.options.authToken}` },
        body: JSON.stringify(body), signal: controller.signal,
      });
      if (response.ok) return;
      const text = await response.text().catch(() => '');
      if (response.status === 404 && /Sandbox .*not found|lifecycle identity not found/i.test(text)) return;
      throw new Error(`ACS ${method} ${path} HTTP ${response.status}: ${text.slice(0, 300) || 'no body'}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

export class SandboxLifecycleService {
  private timer?: NodeJS.Timeout;
  private scanPromise?: Promise<void>;

  constructor(private readonly options: {
    agentCwd: string;
    store: PgSandboxLifecycleStore;
    runStore: Pick<RunStore, 'cancelSteeringBeforeDispatchBySessionWithEvent'>;
    sessionCatalog: Pick<SessionCatalog, 'get'>;
    handStore?: Pick<HandStore, 'get'>;
    tenantRemoteHands: () => TenantRemoteHandDispatchConfig[] | undefined;
    tenantRemoteHandResolver: TenantRemoteHandAuthTokenResolver;
    logger?: SandboxLifecycleLogger;
    fetchImpl?: typeof fetch;
    scanIntervalMs?: number;
  }) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.wake(), this.options.scanIntervalMs ?? 15_000);
    this.timer.unref?.();
    this.wake();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  observeRuntimeEvent(event: PlatformEvent): void {
    if (event.type === 'run_finished' || event.type === 'background_task_finished') this.wake();
  }

  wake(): void {
    if (this.scanPromise) return;
    this.scanPromise = this.scan().catch((error) => {
      this.options.logger?.warn(`sandbox_lifecycle_scan_failed error=${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => { this.scanPromise = undefined; });
  }

  async cancelSessionDeletion(sessionId: string): Promise<void> {
    const record = await this.options.sessionCatalog.get(sessionId);
    await this.options.store.cancelCleanup(sessionId, record?.tenantId);
  }

  async prepareSessionDeletion(sessionId: string): Promise<'skipped' | 'deleted' | 'queued'> {
    const resolved = await this.resolveSessionTarget(sessionId);
    if (!resolved) return 'skipped';
    const { identity, tenantId, client } = resolved;
    await this.cancelScope(identity, tenantId);
    const cleanupRunId = await this.options.store.enqueueCleanup({ ...identity, ...(tenantId ? { tenantId } : {}) });
    try {
      await client.deleteScope(identity);
      if (cleanupRunId) await this.options.store.markCleanupDelivered(cleanupRunId, new Date().toISOString());
      return 'deleted';
    } catch (error) {
      if (!cleanupRunId) throw error;
      this.options.logger?.warn(`sandbox_cleanup_queued session=${sessionId} scope=${identity.sandboxScopeId} error=${error instanceof Error ? error.message : String(error)}`);
      this.wake();
      return 'queued';
    }
  }

  private async scan(): Promise<void> {
    for (const cleanup of await this.options.store.listCleanupCandidates()) {
      const client = await this.resolveClient(cleanup.sessionId, cleanup.tenantId);
      if (!client) continue;
      try {
        await client.deleteScope(cleanup);
        await this.options.store.markCleanupDelivered(cleanup.runId, new Date().toISOString());
      } catch (error) {
        this.options.logger?.warn(`sandbox_cleanup_retry_failed session=${cleanup.sessionId} error=${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const candidate of await this.options.store.listTerminalCandidates()) {
      if (await this.options.store.hasActivity(candidate)) continue;
      const client = await this.resolveClient(candidate.sessionId, candidate.tenantId);
      if (!client) continue;
      try {
        const timedOut = candidate.status === 'failed' && /timed?\s*out|timeout/i.test(candidate.statusReason ?? '');
        await client.notifyTerminal({
          workspaceId: candidate.workspaceId, sessionId: candidate.sessionId,
          sandboxScopeId: candidate.sandboxScopeId,
          terminalState: timedOut ? 'timed-out' : candidate.status === 'orphaned' ? 'failed' : candidate.status,
          terminalAt: candidate.terminalAt,
          outcome: { runId: candidate.runId, status: candidate.status, ...(candidate.statusReason ? { reason: candidate.statusReason } : {}) },
        });
        await this.options.store.markTerminalDelivered(candidate.runId, new Date().toISOString());
      } catch (error) {
        this.options.logger?.warn(`sandbox_terminal_notify_failed run=${candidate.runId} error=${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async cancelScope(identity: SandboxLifecycleIdentity, tenantId?: string): Promise<void> {
    const active = await this.options.store.listActiveScopeRuns(identity, tenantId);
    const cancel = this.options.runStore.cancelSteeringBeforeDispatchBySessionWithEvent;
    if (active.length > 0 && !cancel) throw new Error('Runtime scope cancellation is unavailable');
    for (const run of active) {
      if (!run.tenantId) throw new Error(`Runtime Run tenant 缺失，拒绝删除 scope：${run.runId}`);
      const reason = `session_deleted:${identity.sessionId}`;
      await cancel!.call(this.options.runStore, run.sessionId, reason, run.runId, {
        type: 'run_cancel_requested', sessionId: run.sessionId, runId: run.runId,
        ...(run.userId ? { userId: run.userId } : {}), reason,
      }, run.tenantId);
      runtimeRunController.abort(run.runId, reason);
    }
  }

  private async resolveSessionTarget(sessionId: string): Promise<{
    identity: SandboxLifecycleIdentity;
    tenantId?: string;
    client: AcsSandboxLifecycleClient;
  } | undefined> {
    const record = await this.options.sessionCatalog.get(sessionId);
    if (!record || record.kind === 'subagent') return undefined;
    const client = await this.resolveClient(sessionId, record.tenantId, record);
    if (!client) return undefined;
    const workspaceId = record.workspaceId ?? sessionId;
    const hand = await this.options.handStore?.get(`${sessionId}:server-remote`);
    const recipe = asRecord(asRecord(hand?.metadata).recipe);
    const mountSubPath = stringValue(recipe.mountSubPath)
      ?? deriveWorkspaceMountSubPath({ agentCwd: this.options.agentCwd, cwd: record.cwd });
    const sandboxScopeId = stringValue(recipe.sandboxScopeId)
      ?? deriveSandboxScopeId({ workspaceId, mountSubPath, topLevelSessionId: sessionId });
    return {
      identity: { workspaceId, sessionId, sandboxScopeId },
      ...(record.tenantId ? { tenantId: record.tenantId } : {}), client,
    };
  }

  private async resolveClient(
    sessionId: string,
    tenantId?: string,
    knownRecord?: Awaited<ReturnType<SessionCatalog['get']>>,
  ): Promise<AcsSandboxLifecycleClient | undefined> {
    const record = knownRecord ?? await this.options.sessionCatalog.get(sessionId);
    const entry = selectTenantRemoteHandsForRegistration(this.options.tenantRemoteHands(), {
      userId: record?.userId, username: record?.username, userTenantId: tenantId ?? record?.tenantId,
    }).find((hand) => hand.id === 'agent-saas-acs')
      ?? selectTenantRemoteHandsForRegistration(this.options.tenantRemoteHands(), {
        userId: record?.userId, username: record?.username, userTenantId: tenantId ?? record?.tenantId,
      }).find((hand) => /acs/i.test(hand.id));
    if (!entry) return undefined;
    const resolved = await this.options.tenantRemoteHandResolver.resolveForRegister(entry);
    return new AcsSandboxLifecycleClient({
      baseUrl: resolved.baseUrl, authToken: resolved.authToken, fetchImpl: this.options.fetchImpl,
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseWorkload(value: unknown): SandboxWorkloadDescriptor | undefined {
  const raw = asRecord(value);
  if (raw.kind === 'interactive' || raw.kind === 'cron' || raw.kind === 'memory') return { kind: raw.kind };
  if (raw.kind !== 'taskboard') return undefined;
  return {
    kind: 'taskboard',
    ...(typeof raw.taskKind === 'string' ? { taskKind: raw.taskKind as Extract<SandboxWorkloadDescriptor, { kind: 'taskboard' }>['taskKind'] } : {}),
    ...(typeof raw.purpose === 'string' ? { purpose: raw.purpose as Extract<SandboxWorkloadDescriptor, { kind: 'taskboard' }>['purpose'] } : {}),
  };
}
