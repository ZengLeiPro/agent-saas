import { createHash } from 'crypto';
import type { GovernancePgPool } from '../data/governance-schema/index.js';
import { PgGovernanceMigrationRunner, governanceTablePrefix } from '../data/governance-schema/index.js';
import type { AccessDecision } from '../governance/access/types.js';
import type { ExecutionReadiness } from '../governance/readiness/evaluator.js';

export interface ResolvedResourceRef {
  id: string;
  version?: number;
  versionId?: string;
  revision?: number;
  generation?: number;
  bindingId?: string;
  templateId?: string;
  templateVersionId?: string;
  scopes?: string[];
}

export interface ResolvedEnvironmentRef extends ResolvedResourceRef {
  providerId: string;
  templateVersionId?: string;
  instanceId?: string;
  recipeDigest?: string;
}

export interface RunResolutionSnapshotDraft {
  runId: string;
  sessionId: string;
  tenantId?: string;
  enforcementMode: 'shadow' | 'enforce';
  migrationControlRevision?: number;
  actor: {
    subjectType: 'human' | 'service';
    subjectId: string;
    tenantId?: string;
    persona?: string;
    delegatedUserId?: string;
  };
  accessDecision: AccessDecision;
  readiness: ExecutionReadiness;
  agent: ResolvedResourceRef & {
    type: 'org_agent' | 'personal_agent';
    executionMode?: 'direct' | 'dispatcher';
    executionRole?: 'dispatcher' | 'worker';
  };
  skills: ResolvedResourceRef[];
  connectors: ResolvedResourceRef[];
  credentialBindings: ResolvedResourceRef[];
  environment?: ResolvedEnvironmentRef;
  memoryScopes: ResolvedResourceRef[];
  model?: ResolvedResourceRef;
  resolvedAt: string;
}

export interface RunResolutionSnapshot extends RunResolutionSnapshotDraft {
  digest: string;
  createdAt: string;
}

const FORBIDDEN_SNAPSHOT_KEYS = new Set([
  'arguments',
  'content',
  'input',
  'memorytext',
  'message',
  'messages',
  'password',
  'rawparams',
  'secret',
  'secretvalue',
  'token',
  'wakeMessage'.toLowerCase(),
]);

function assertNoSensitivePayload(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitivePayload(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_SNAPSHOT_KEYS.has(key.toLowerCase())) {
      throw new Error(`RUN_SNAPSHOT_SENSITIVE_FIELD:${path}.${key}`);
    }
    assertNoSensitivePayload(child, `${path}.${key}`);
  }
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalize(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter(key => record[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

function digestSnapshot(snapshot: RunResolutionSnapshotDraft): string {
  return createHash('sha256').update(canonicalize(snapshot)).digest('hex');
}

export class PgRunResolutionSnapshotStore {
  readonly tableName: string;
  private readonly tablePrefix: string;

  constructor(
    private readonly pool: GovernancePgPool,
    tablePrefix?: string,
  ) {
    this.tablePrefix = governanceTablePrefix(tablePrefix);
    this.tableName = `${this.tablePrefix}_run_resolution_snapshots`;
  }

  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(this.pool, this.tablePrefix).run();
  }

  async append(draft: RunResolutionSnapshotDraft): Promise<RunResolutionSnapshot> {
    assertNoSensitivePayload(draft);
    const digest = digestSnapshot(draft);
    const inserted = await this.pool.query(`
      INSERT INTO ${this.tableName} (
        run_id, session_id, tenant_id, subject_type, subject_id,
        access_decision_id, enforcement_mode, access_verdict, readiness_ready,
        snapshot_digest, snapshot_json
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
      ON CONFLICT (run_id,snapshot_digest) DO NOTHING
      RETURNING created_at
    `, [
      draft.runId,
      draft.sessionId,
      draft.tenantId ?? null,
      draft.actor.subjectType,
      draft.actor.subjectId,
      draft.accessDecision.id,
      draft.enforcementMode,
      draft.accessDecision.verdict,
      draft.readiness.ready,
      digest,
      JSON.stringify(draft),
    ]);
    if (inserted.rows[0]) {
      return { ...draft, digest, createdAt: new Date(inserted.rows[0].created_at as string | Date).toISOString() };
    }
    const existingResult = await this.pool.query(
      `SELECT snapshot_json, snapshot_digest, created_at FROM ${this.tableName}
       WHERE run_id=$1 AND snapshot_digest=$2`,
      [draft.runId, digest],
    );
    const existing = existingResult.rows[0];
    if (!existing) throw new Error('RUN_SNAPSHOT_CONFLICT');
    return {
      ...(existing.snapshot_json as RunResolutionSnapshotDraft),
      digest: String(existing.snapshot_digest),
      createdAt: new Date(existing.created_at as string | Date).toISOString(),
    };
  }

  async get(runId: string): Promise<RunResolutionSnapshot | null> {
    const result = await this.pool.query(
      `SELECT snapshot_json, snapshot_digest, created_at FROM ${this.tableName}
       WHERE run_id = $1 ORDER BY snapshot_sequence DESC LIMIT 1`,
      [runId],
    );
    if (!result.rows[0]) return null;
    return {
      ...(result.rows[0].snapshot_json as RunResolutionSnapshotDraft),
      digest: String(result.rows[0].snapshot_digest),
      createdAt: new Date(result.rows[0].created_at as string | Date).toISOString(),
    };
  }
}

export { assertNoSensitivePayload as assertRunSnapshotHasNoSensitivePayload };
