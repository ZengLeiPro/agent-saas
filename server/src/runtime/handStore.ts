import pg from 'pg';
import type { ExecutionTargetKind, ToolDescriptor, ToolRisk } from '../agent/toolRuntime.js';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

export type HandStatus = 'provisioning' | 'ready' | 'unhealthy' | 'destroyed';

export interface HandCapability {
  name: string;
  description: string;
  tools: ToolDescriptor[];
  constraints: string[];
  risk: ToolRisk;
}

export interface WorkspaceRecipe {
  workspaceId: string;
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
  setupCommands?: string[];
  resources?: { cpu?: string; memoryMb?: number; diskMb?: number; timeoutMs?: number };
}

export interface HandRecord {
  handId: string;
  sessionId?: string;
  workspaceId: string;
  type: ExecutionTargetKind;
  status: HandStatus;
  endpoint?: string;
  capabilities: HandCapability[];
  createdAt: string;
  updatedAt: string;
  leaseExpiresAt?: string;
  metadata: Record<string, unknown>;
}

/**
 * B2: Pick the single ready tenant-remote hand from a session's hand records,
 * if and only if there is exactly one. Returns `undefined` for 0 or >1
 * candidates so callers fall back to the default executionTarget. Ordinary
 * workspace tools do not expose handId as a model-facing parameter.
 *
 * Candidate filter:
 *   - status === 'ready'
 *   - type === 'server-remote'
 *   - metadata.tenantRemoteHandId is a non-empty string (i.e. tenant origin)
 *
 * Pure helper — kept here so both `WorkspaceToolProvider` (transport routing)
 * and `RawAgentLoop` (invocation metadata) share one decision rule.
 */
export function pickSoleReadyTenantHandId(
  hands: ReadonlyArray<HandRecord>,
): string | undefined {
  const candidates = hands.filter((h) =>
    h.status === 'ready'
    && h.type === 'server-remote'
    && typeof h.metadata?.tenantRemoteHandId === 'string'
    && (h.metadata.tenantRemoteHandId as string).length > 0,
  );
  return candidates.length === 1 ? candidates[0]!.handId : undefined;
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
  metadata?: Record<string, unknown>;
}

export interface HandStore {
  init?(): Promise<void>;
  register(input: RegisterHandInput): Promise<HandRecord>;
  updateStatus(handId: string, status: HandStatus, metadataPatch?: Record<string, unknown>): Promise<HandRecord | null>;
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
}

export interface PgHandStoreOptions {
  pool?: PgPool;
  connectionString?: string;
  tablePrefix?: string;
}

export class PgHandStore implements HandStore {
  readonly pool: PgPool;
  readonly handsTable: string;
  private readonly ownsPool: boolean;

  constructor(options: PgHandStoreOptions) {
    if (!options.pool && !options.connectionString) throw new Error('PgHandStore requires either pool or connectionString');
    const prefix = sanitizeIdentifier(options.tablePrefix ?? 'runtime');
    this.handsTable = `${prefix}_hands`;
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
        metadata JSONB NOT NULL DEFAULT '{}'
      )
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.handsTable}_session_idx ON ${this.handsTable} (session_id)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.handsTable}_workspace_idx ON ${this.handsTable} (workspace_id)`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS ${this.handsTable}_status_idx ON ${this.handsTable} (status)`);
  }

  async close(): Promise<void> { if (this.ownsPool) await this.pool.end(); }

  async register(input: RegisterHandInput): Promise<HandRecord> {
    const result = await this.pool.query<{ row_json: unknown }>(`
      INSERT INTO ${this.handsTable}
        (hand_id, session_id, workspace_id, type, status, endpoint, capabilities, lease_expires_at, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb)
      ON CONFLICT (hand_id) DO UPDATE SET
        session_id = EXCLUDED.session_id,
        workspace_id = EXCLUDED.workspace_id,
        type = EXCLUDED.type,
        status = EXCLUDED.status,
        endpoint = EXCLUDED.endpoint,
        capabilities = EXCLUDED.capabilities,
        lease_expires_at = EXCLUDED.lease_expires_at,
        metadata = ${this.handsTable}.metadata || EXCLUDED.metadata,
        updated_at = now()
      RETURNING row_to_json(${this.handsTable}.*) AS row_json
    `, [
      input.handId,
      input.sessionId ?? null,
      input.workspaceId,
      input.type,
      input.status ?? 'ready',
      input.endpoint ?? null,
      JSON.stringify(input.capabilities ?? []),
      input.leaseExpiresAt?.toISOString() ?? null,
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

  async listByType(type: ExecutionTargetKind, opts?: { status?: HandStatus }): Promise<HandRecord[]> {
    if (opts?.status) {
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
    type: raw.type,
    status: raw.status,
    endpoint: raw.endpoint ?? undefined,
    capabilities: raw.capabilities ?? [],
    createdAt: new Date(raw.created_at ?? raw.createdAt).toISOString(),
    updatedAt: new Date(raw.updated_at ?? raw.updatedAt).toISOString(),
    leaseExpiresAt: raw.lease_expires_at ? new Date(raw.lease_expires_at).toISOString() : raw.leaseExpiresAt,
    metadata: raw.metadata ?? {},
  };
}
