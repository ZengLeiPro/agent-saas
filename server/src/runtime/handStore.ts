import pg from 'pg';
import type { ExecutionTargetKind, ToolDescriptor, ToolRisk } from '../agent/toolRuntime.js';
import { parseWorkspaceId } from './workspaceIdentity.js';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

export type HandStatus = 'provisioning' | 'ready' | 'unhealthy' | 'destroyed';

/**
 * 2026-08-03 CPU 治理 P1：server-remote hand 记录的默认租约时长。
 *
 * hands 是 per-session 记录（`${sessionId}:server-remote`），历史上从不回收，
 * 生产累积 900+ 条（其中 29 条还指向 07-02 已拆除的旧 WireGuard 地址），是
 * HandHealthScanner 全量扫描被放大的根源。register 是 upsert：活跃 session
 * 每次 dispatch 都会刷新租约；到期后由 janitor 标 destroyed（软删），此后同
 * session 再 dispatch 会通过 upsert 复活（status/lease 一并重置），无误杀风险。
 */
export const SERVER_REMOTE_HAND_LEASE_MS = 30 * 24 * 60 * 60_000;

export interface HandLeaseSweepResult {
  /** 存量无租约记录补租约的条数 */
  backfilled: number;
  /** 租约过期被标 destroyed 的条数 */
  destroyed: number;
  /** destroyed 超过保留期被物理删除的条数 */
  purged: number;
}

export interface HandCapability {
  name: string;
  description: string;
  tools: ToolDescriptor[];
  constraints: string[];
  risk: ToolRisk;
}

export interface WorkspaceRecipe {
  workspaceId: string;
  /** Server-issued only. ACS must attest the exact SandboxRef provisioned for this run. */
  runtimeIsolationRequirement?: import('./runtimeIsolationEvidence.js').RuntimeIsolationRequirement;
  /**
   * Underlying execution-runtime pooling key. Session records can stay
   * session-scoped while ACS maps multiple sessions for the same user workspace
   * to one warm Sandbox.
   */
  sandboxScopeId?: string;
  /**
   * Optional session identity for execution planes whose lifecycle is
   * session-scoped. ACS keeps it for audit even when the underlying Sandbox is
   * pooled by sandboxScopeId.
   */
  sessionId?: string;
  /**
   * Optional NAS/PVC subPath mounted as the execution workspace. `workspaceId`
   * remains the logical/audit id; this field is the physical workspace path
   * relative to the orchestrator's workspace root.
   */
  mountSubPath?: string;
  repo?: { url: string; ref?: string; remote?: string };
  files?: Array<{ artifactId: string; path: string; url?: string; signedUrl?: string }>;
  packages?: string[];
  envKeys?: string[];
  setupCommands?: string[];
  /** Stable transport idempotency key for crash-safe provisioning retries. */
  provisionKey?: string;
  resources?: { cpu?: string; memoryMb?: number; diskMb?: number; timeoutMs?: number };
}

export interface HandRecord {
  handId: string;
  sessionId?: string;
  workspaceId: string;
  tenantId?: string;
  userId?: string;
  type: ExecutionTargetKind;
  status: HandStatus;
  endpoint?: string;
  capabilities: HandCapability[];
  createdAt: string;
  updatedAt: string;
  leaseExpiresAt?: string;
  /** Environment Instance 领域引用；均为不可变 ID/version，不含 Provider Secret。 */
  providerId?: string;
  templateVersionId?: string;
  runId?: string;
  recipeDigest?: string;
  terminatedAt?: string;
  metadata: Record<string, unknown>;
}

/** Actual workspace execution boundary selected by both the harness audit path and tool transport. */
export type RuntimeHandRoute =
  | { kind: 'none' }
  | { kind: 'ready'; handId: string; attested: boolean }
  | { kind: 'blocked'; message: string };

export interface RuntimeHandRouteContext {
  runId?: string;
  executionTarget?: ExecutionTargetKind;
  runtimeIsolationRequirement?: import('./runtimeIsolationEvidence.js').RuntimeIsolationRequirement;
}

export function hasUnresolvedHandProvisionFailure(hand: Pick<HandRecord, 'metadata'>): boolean {
  const metadata = hand.metadata ?? {};
  const directFailure = metadata.provisionFailure;
  if (typeof directFailure === 'string' ? directFailure.trim().length > 0 : Boolean(directFailure)) return true;
  const provision = metadata.provision;
  return Boolean(
    provision
    && typeof provision === 'object'
    && !Array.isArray(provision)
    && (provision as Record<string, unknown>).lastStatus === 'error',
  );
}

function isReadyAttestedDefaultHand(hand: HandRecord, context: RuntimeHandRouteContext): boolean {
  const runId = context.runId;
  if (!runId) return false;
  const metadata = hand.metadata ?? {};
  return hand.status === 'ready'
    && !hasUnresolvedHandProvisionFailure(hand)
    && hand.type === 'server-remote'
    && typeof metadata.tenantRemoteHandId !== 'string'
    && metadata.runtimeIsolationAttested === true
    && hand.runId === runId
    && metadata.runId === runId
    && typeof metadata.policyDigest === 'string'
    && (!context.runtimeIsolationRequirement
      || metadata.policyDigest === context.runtimeIsolationRequirement.policyDigest)
    && typeof metadata.sandboxName === 'string'
    && metadata.sandboxName.length > 0
    && typeof metadata.sandboxScopeId === 'string'
    && metadata.sandboxScopeId.length > 0;
}

/**
 * Select the sole usable hand for a tool call.
 *
 * A ready default hand attested for the exact current run always wins and tenant-origin
 * records are never considered beside it. If this run declares isolation attestation,
 * absence or ambiguity of that exact binding is fail closed. Non-attested runs retain the
 * legacy sole-ready-tenant routing rule.
 */
export function selectRuntimeHandRoute(
  hands: ReadonlyArray<HandRecord>,
  context: RuntimeHandRouteContext = {},
): RuntimeHandRoute {
  if (context.runtimeIsolationRequirement && context.runId !== context.runtimeIsolationRequirement.runId) {
    return { kind: 'blocked', message: 'RUNTIME_ISOLATION_RUN_CONTEXT_MISMATCH' };
  }
  const attested = hands.filter((hand) => isReadyAttestedDefaultHand(hand, context));
  if (attested.length === 1) return { kind: 'ready', handId: attested[0]!.handId, attested: true };
  if (attested.length > 1) {
    return { kind: 'blocked', message: 'RUNTIME_ISOLATION_HAND_AMBIGUOUS' };
  }
  if (context.runtimeIsolationRequirement) {
    return { kind: 'blocked', message: 'RUNTIME_ISOLATION_ATTESTED_HAND_MISSING' };
  }

  const tenantCandidates = hands.filter((hand) =>
    hand.status === 'ready'
    && !hasUnresolvedHandProvisionFailure(hand)
    && hand.type === 'server-remote'
    && typeof hand.metadata?.tenantRemoteHandId === 'string'
    && (hand.metadata.tenantRemoteHandId as string).length > 0,
  );
  if (tenantCandidates.length === 1) {
    return { kind: 'ready', handId: tenantCandidates[0]!.handId, attested: false };
  }
  if (tenantCandidates.length > 1) return { kind: 'none' };

  // 非 attested legacy 流程仍由默认 transport 执行，但已有 default hand 明确失败时
  // 必须阻止 fallback 绕过其状态；ready default 保持旧的 kind:none 兼容语义。
  const unavailableDefault = hands.some((hand) => (
    (!context.executionTarget || hand.type === context.executionTarget)
    && typeof hand.metadata?.tenantRemoteHandId !== 'string'
    && (hand.status !== 'ready' || hasUnresolvedHandProvisionFailure(hand))
  ));
  return unavailableDefault
    ? { kind: 'blocked', message: 'RUNTIME_DEFAULT_HAND_UNAVAILABLE' }
    : { kind: 'none' };
}

/** @deprecated Prefer selectRuntimeHandRoute so attested runs can fail closed. */
export function pickSoleReadyTenantHandId(hands: ReadonlyArray<HandRecord>): string | undefined {
  const route = selectRuntimeHandRoute(hands);
  return route.kind === 'ready' ? route.handId : undefined;
}

export interface RegisterHandInput {
  handId: string;
  sessionId?: string;
  workspaceId: string;
  type: ExecutionTargetKind;
  status?: HandStatus;
  endpoint?: string;
  capabilities?: HandCapability[];
  leaseExpiresAt?: Date;
  providerId?: string;
  templateVersionId?: string;
  runId?: string;
  recipeDigest?: string;
  terminatedAt?: Date;
  metadata?: Record<string, unknown>;
}

export const PROVISION_RECOVERY_CLAIM_TTL_MS = 5 * 60_000;

export interface HandStore {
  init?(): Promise<void>;
  register(input: RegisterHandInput): Promise<HandRecord>;
  updateStatus(handId: string, status: HandStatus, metadataPatch?: Record<string, unknown>): Promise<HandRecord | null>;
  /** Atomically claims an unresolved provision failure for one scanner recovery attempt. */
  claimProvisionRecovery(
    handId: string,
    recoveryToken: string,
    metadataPatch?: Record<string, unknown>,
    expectedUpdatedAt?: string,
    expectedProvisionGeneration?: string,
  ): Promise<HandRecord | null>;
  /** Completes a normal provision attempt only while its generation still owns the Hand. */
  completeProvisionAttempt(
    handId: string,
    provisionGeneration: string,
    status: HandStatus,
    metadataPatch?: Record<string, unknown>,
  ): Promise<HandRecord | null>;
  /** Applies a scanner recovery result only while its claim token is still current. */
  completeProvisionRecovery(
    handId: string,
    recoveryToken: string,
    status: HandStatus,
    metadataPatch?: Record<string, unknown>,
  ): Promise<HandRecord | null>;
  get(handId: string): Promise<HandRecord | null>;
  listBySession(sessionId: string): Promise<HandRecord[]>;
  listByWorkspace(workspaceId: string): Promise<HandRecord[]>;
  /**
   * B4: List all hands of a given execution target kind, optionally filtered by
   * status. Used by the health/lease scanner to find server-remote hands that
   * need a periodic /health probe. Implementations should be cheap — the
   * scanner runs every ~30s.
   */
  listByType?(type: ExecutionTargetKind, opts?: { status?: HandStatus }): Promise<HandRecord[]>;
  /**
   * 2026-08-03 P1：server-remote hand 租约巡检（backfill 存量租约 → 过期标
   * destroyed → 超保留期物理清除）。幂等，可安全重复执行；只作用于
   * type='server-remote'。
   */
  sweepLeases?(opts?: { leaseMs?: number; destroyedRetentionMs?: number }): Promise<HandLeaseSweepResult>;
}

export interface PgHandStoreOptions {
  pool?: PgPool;
  connectionString?: string;
  tablePrefix?: string;
}

export class PgHandStore implements HandStore {
  readonly pool: PgPool;
  readonly handsTable: string;
  readonly runsTable: string;
  private readonly ownsPool: boolean;

  constructor(options: PgHandStoreOptions) {
    if (!options.pool && !options.connectionString) throw new Error('PgHandStore requires either pool or connectionString');
    const prefix = sanitizeIdentifier(options.tablePrefix ?? 'runtime');
    this.handsTable = `${prefix}_hands`;
    this.runsTable = `${prefix}_runs`;
    this.pool = options.pool ?? new Pool({ connectionString: options.connectionString! });
    this.ownsPool = !options.pool;
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.handsTable} (
        hand_id TEXT PRIMARY KEY,
        session_id TEXT,
        workspace_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        endpoint TEXT,
        capabilities JSONB NOT NULL DEFAULT '[]',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        lease_expires_at TIMESTAMPTZ,
        provider_id TEXT,
        template_version_id TEXT,
        run_id TEXT,
        recipe_digest TEXT,
        terminated_at TIMESTAMPTZ,
        metadata JSONB NOT NULL DEFAULT '{}'
      )
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.handsTable}_session_idx ON ${this.handsTable} (session_id)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.handsTable}_workspace_idx ON ${this.handsTable} (workspace_id)`);
    await this.pool.query(`ALTER TABLE ${this.handsTable} ADD COLUMN IF NOT EXISTS tenant_id TEXT`);
    await this.pool.query(`ALTER TABLE ${this.handsTable} ADD COLUMN IF NOT EXISTS user_id TEXT`);
    await this.pool.query(`ALTER TABLE ${this.handsTable} ADD COLUMN IF NOT EXISTS provider_id TEXT`);
    await this.pool.query(`ALTER TABLE ${this.handsTable} ADD COLUMN IF NOT EXISTS template_version_id TEXT`);
    await this.pool.query(`ALTER TABLE ${this.handsTable} ADD COLUMN IF NOT EXISTS run_id TEXT`);
    await this.pool.query(`ALTER TABLE ${this.handsTable} ADD COLUMN IF NOT EXISTS recipe_digest TEXT`);
    await this.pool.query(`ALTER TABLE ${this.handsTable} ADD COLUMN IF NOT EXISTS terminated_at TIMESTAMPTZ`);
    await this.pool.query(`
      UPDATE ${this.handsTable}
      SET tenant_id = split_part(substring(workspace_id from 4), '__', 1),
          user_id = split_part(substring(workspace_id from 4), '__', 2)
      WHERE tenant_id IS NULL
        AND workspace_id ~ '^ws_[a-z][a-z0-9-]{1,30}__[A-Za-z0-9_-]{1,80}(__.*)?$'
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.handsTable}_tenant_idx ON ${this.handsTable} (tenant_id)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.handsTable}_status_idx ON ${this.handsTable} (status)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.handsTable}_provider_idx ON ${this.handsTable} (provider_id, status)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.handsTable}_template_idx ON ${this.handsTable} (template_version_id)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.handsTable}_run_idx ON ${this.handsTable} (run_id)`);
  }

  async close(): Promise<void> { if (this.ownsPool) await this.pool.end(); }

  async register(input: RegisterHandInput): Promise<HandRecord> {
    const owner = parseWorkspaceId(input.workspaceId);
    const result = await this.pool.query<{ row_json: unknown }>(`
      INSERT INTO ${this.handsTable}
        (hand_id, session_id, workspace_id, tenant_id, user_id, type, status, endpoint,
         capabilities, lease_expires_at, provider_id, template_version_id, run_id,
         recipe_digest, terminated_at, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16::jsonb)
      ON CONFLICT (hand_id) DO UPDATE SET
        session_id = EXCLUDED.session_id,
        workspace_id = EXCLUDED.workspace_id,
        tenant_id = EXCLUDED.tenant_id,
        user_id = EXCLUDED.user_id,
        type = EXCLUDED.type,
        status = EXCLUDED.status,
        endpoint = EXCLUDED.endpoint,
        capabilities = EXCLUDED.capabilities,
        lease_expires_at = EXCLUDED.lease_expires_at,
        provider_id = EXCLUDED.provider_id,
        template_version_id = EXCLUDED.template_version_id,
        run_id = EXCLUDED.run_id,
        recipe_digest = EXCLUDED.recipe_digest,
        terminated_at = EXCLUDED.terminated_at,
        metadata = ${this.handsTable}.metadata || EXCLUDED.metadata,
        updated_at = now()
      RETURNING row_to_json(${this.handsTable}.*) AS row_json
    `, [
      input.handId,
      input.sessionId ?? null,
      input.workspaceId,
      owner?.tenantId ?? null,
      owner?.userId ?? null,
      input.type,
      input.status ?? 'ready',
      input.endpoint ?? null,
      JSON.stringify(input.capabilities ?? []),
      input.leaseExpiresAt?.toISOString() ?? null,
      input.providerId ?? null,
      input.templateVersionId ?? null,
      input.runId ?? null,
      input.recipeDigest ?? null,
      input.terminatedAt?.toISOString() ?? null,
      JSON.stringify(input.metadata ?? {}),
    ]);
    return normalizeHandRecord(result.rows[0]!.row_json);
  }

  async updateStatus(handId: string, status: HandStatus, metadataPatch: Record<string, unknown> = {}): Promise<HandRecord | null> {
    const result = await this.pool.query<{ row_json: unknown }>(`
      UPDATE ${this.handsTable}
      SET status = $2, metadata = metadata || $3::jsonb, updated_at = now()
      WHERE hand_id = $1
      RETURNING row_to_json(${this.handsTable}.*) AS row_json
    `, [handId, status, JSON.stringify(metadataPatch)]);
    return result.rows[0] ? normalizeHandRecord(result.rows[0].row_json) : null;
  }

  async claimProvisionRecovery(
    handId: string,
    recoveryToken: string,
    metadataPatch: Record<string, unknown> = {},
    expectedUpdatedAt?: string,
    expectedProvisionGeneration?: string,
  ): Promise<HandRecord | null> {
    const patch = { ...metadataPatch, provisionRecoveryToken: recoveryToken };
    const result = await this.pool.query<{ row_json: unknown }>(`
      UPDATE ${this.handsTable}
      SET status = 'unhealthy',
          metadata = metadata || $2::jsonb || jsonb_build_object(
            'provisionRecoveryClaimedAtMs', floor(extract(epoch FROM now()) * 1000)::bigint
          ),
          updated_at = now()
      WHERE hand_id = $1
        AND status IN ('ready', 'unhealthy')
        AND (lease_expires_at IS NULL OR lease_expires_at > now())
        AND ($4::timestamptz IS NULL OR date_trunc('milliseconds', updated_at) = $4::timestamptz)
        AND ($5::text IS NULL OR metadata->>'provisionGeneration' = $5)
        AND (
          COALESCE(metadata->>'provisionRecoveryToken', '') = ''
          OR CASE
            WHEN jsonb_typeof(metadata->'provisionRecoveryClaimedAtMs') = 'number'
              THEN (metadata->>'provisionRecoveryClaimedAtMs')::numeric
                < floor(extract(epoch FROM now()) * 1000)::numeric - $3::numeric
            ELSE TRUE
          END
        )
      RETURNING row_to_json(${this.handsTable}.*) AS row_json
    `, [
      handId,
      JSON.stringify(patch),
      PROVISION_RECOVERY_CLAIM_TTL_MS,
      expectedUpdatedAt ?? null,
      expectedProvisionGeneration ?? null,
    ]);
    return result.rows[0] ? normalizeHandRecord(result.rows[0].row_json) : null;
  }

  async completeProvisionAttempt(
    handId: string,
    provisionGeneration: string,
    status: HandStatus,
    metadataPatch: Record<string, unknown> = {},
  ): Promise<HandRecord | null> {
    const result = await this.pool.query<{ row_json: unknown }>(`
      UPDATE ${this.handsTable}
      SET status = $3, metadata = metadata || $4::jsonb, updated_at = now()
      WHERE hand_id = $1
        AND status = 'provisioning'
        AND (lease_expires_at IS NULL OR lease_expires_at > now())
        AND metadata->>'provisionGeneration' = $2
      RETURNING row_to_json(${this.handsTable}.*) AS row_json
    `, [handId, provisionGeneration, status, JSON.stringify(metadataPatch)]);
    return result.rows[0] ? normalizeHandRecord(result.rows[0].row_json) : null;
  }

  async completeProvisionRecovery(
    handId: string,
    recoveryToken: string,
    status: HandStatus,
    metadataPatch: Record<string, unknown> = {},
  ): Promise<HandRecord | null> {
    const patch = {
      ...metadataPatch,
      provisionRecoveryToken: null,
      provisionRecoveryClaimedAtMs: null,
    };
    const result = await this.pool.query<{ row_json: unknown }>(`
      UPDATE ${this.handsTable}
      SET status = $3, metadata = metadata || $4::jsonb, updated_at = now()
      WHERE hand_id = $1
        AND status = 'unhealthy'
        AND (lease_expires_at IS NULL OR lease_expires_at > now())
        AND metadata->>'provisionRecoveryToken' = $2
      RETURNING row_to_json(${this.handsTable}.*) AS row_json
    `, [handId, recoveryToken, status, JSON.stringify(patch)]);
    return result.rows[0] ? normalizeHandRecord(result.rows[0].row_json) : null;
  }

  async get(handId: string): Promise<HandRecord | null> {
    const result = await this.pool.query<{ row_json: unknown }>(`SELECT row_to_json(${this.handsTable}.*) AS row_json FROM ${this.handsTable} WHERE hand_id = $1`, [handId]);
    return result.rows[0] ? normalizeHandRecord(result.rows[0].row_json) : null;
  }

  async listBySession(sessionId: string): Promise<HandRecord[]> {
    const result = await this.pool.query<{ row_json: unknown }>(`SELECT row_to_json(${this.handsTable}.*) AS row_json FROM ${this.handsTable} WHERE session_id = $1 ORDER BY updated_at DESC`, [sessionId]);
    return result.rows.map((r) => normalizeHandRecord(r.row_json));
  }

  async listByWorkspace(workspaceId: string): Promise<HandRecord[]> {
    const result = await this.pool.query<{ row_json: unknown }>(`SELECT row_to_json(${this.handsTable}.*) AS row_json FROM ${this.handsTable} WHERE workspace_id = $1 ORDER BY updated_at DESC`, [workspaceId]);
    return result.rows.map((r) => normalizeHandRecord(r.row_json));
  }

  async deleteByWorkspaceIds(workspaceIds: string[]): Promise<number> {
    if (workspaceIds.length === 0) return 0;
    const result = await this.pool.query(
      `DELETE FROM ${this.handsTable} WHERE workspace_id = ANY($1::text[])`,
      [workspaceIds],
    );
    return result.rowCount ?? 0;
  }

  async listByType(type: ExecutionTargetKind, opts?: { status?: HandStatus }): Promise<HandRecord[]> {
    if (opts?.status) {
      if (opts.status === 'unhealthy') {
        const result = await this.pool.query<{ row_json: unknown }>(`
          SELECT row_to_json(hand.*) AS row_json
          FROM ${this.handsTable} hand
          WHERE hand.type = $1
            AND hand.status = $2
            AND EXISTS (
              SELECT 1 FROM ${this.runsTable} run
              WHERE run.session_id = hand.session_id
                AND run.status IN ('pending', 'running', 'waiting_hand')
            )
          ORDER BY hand.updated_at DESC
        `, [type, opts.status]);
        return result.rows.map((r) => normalizeHandRecord(r.row_json));
      }
      const result = await this.pool.query<{ row_json: unknown }>(
        `SELECT row_to_json(${this.handsTable}.*) AS row_json FROM ${this.handsTable} WHERE type = $1 AND status = $2 ORDER BY updated_at ASC`,
        [type, opts.status],
      );
      return result.rows.map((r) => normalizeHandRecord(r.row_json));
    }
    const result = await this.pool.query<{ row_json: unknown }>(
      `SELECT row_to_json(${this.handsTable}.*) AS row_json FROM ${this.handsTable} WHERE type = $1 ORDER BY updated_at ASC`,
      [type],
    );
    return result.rows.map((r) => normalizeHandRecord(r.row_json));
  }

  async sweepLeases(opts?: { leaseMs?: number; destroyedRetentionMs?: number }): Promise<HandLeaseSweepResult> {
    const leaseMs = Math.max(60_000, opts?.leaseMs ?? SERVER_REMOTE_HAND_LEASE_MS);
    const retentionMs = Math.max(60_000, opts?.destroyedRetentionMs ?? 14 * 24 * 60 * 60_000);
    // ① 存量补租约：以最后活动时间（updated_at 与 created_at 较新者）+ leaseMs
    //    为准，让老僵尸按真实闲置时长自然到期，而不是从"现在"重新计时 30 天。
    const backfill = await this.pool.query(
      `UPDATE ${this.handsTable}
       SET lease_expires_at = GREATEST(created_at, updated_at) + ($1 * interval '1 millisecond')
       WHERE type = 'server-remote' AND lease_expires_at IS NULL AND status <> 'destroyed'`,
      [leaseMs],
    );
    // ② 过期 → destroyed（软删，保留审计与 upsert 复活能力）
    const destroy = await this.pool.query(
      `UPDATE ${this.handsTable}
       SET status = 'destroyed',
           metadata = metadata || jsonb_build_object('destroyReason', 'lease_expired'),
           updated_at = now()
       WHERE type = 'server-remote' AND status IN ('provisioning', 'ready', 'unhealthy')
         AND lease_expires_at IS NOT NULL AND lease_expires_at < now()`,
    );
    // ③ destroyed 超保留期 → 物理清除
    const purge = await this.pool.query(
      `DELETE FROM ${this.handsTable}
       WHERE type = 'server-remote' AND status = 'destroyed'
         AND updated_at < now() - ($1 * interval '1 millisecond')`,
      [retentionMs],
    );
    return {
      backfilled: backfill.rowCount ?? 0,
      destroyed: destroy.rowCount ?? 0,
      purged: purge.rowCount ?? 0,
    };
  }
}

function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`非法 PG tablePrefix: ${value}`);
  return value;
}

function normalizeHandRecord(raw: any): HandRecord {
  return {
    handId: raw.hand_id ?? raw.handId,
    sessionId: raw.session_id ?? raw.sessionId ?? undefined,
    workspaceId: raw.workspace_id ?? raw.workspaceId,
    tenantId: raw.tenant_id ?? raw.tenantId ?? undefined,
    userId: raw.user_id ?? raw.userId ?? undefined,
    type: raw.type,
    status: raw.status,
    endpoint: raw.endpoint ?? undefined,
    capabilities: raw.capabilities ?? [],
    createdAt: new Date(raw.created_at ?? raw.createdAt).toISOString(),
    updatedAt: new Date(raw.updated_at ?? raw.updatedAt).toISOString(),
    leaseExpiresAt: raw.lease_expires_at ? new Date(raw.lease_expires_at).toISOString() : raw.leaseExpiresAt,
    providerId: raw.provider_id ?? raw.providerId ?? undefined,
    templateVersionId: raw.template_version_id ?? raw.templateVersionId ?? undefined,
    runId: raw.run_id ?? raw.runId ?? undefined,
    recipeDigest: raw.recipe_digest ?? raw.recipeDigest ?? undefined,
    terminatedAt: raw.terminated_at ? new Date(raw.terminated_at).toISOString() : raw.terminatedAt,
    metadata: raw.metadata ?? {},
  };
}
