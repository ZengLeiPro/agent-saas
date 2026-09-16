import { governanceTablePrefix, type GovernancePgPool } from '../data/governance-schema/index.js';
import type { PlatformDemoSessionDraft } from './types.js';
import { platformDemoSessionKey } from './types.js';
import type { PlatformDemoSessionStore } from './demoSessionStore.js';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface PgPlatformDemoSessionStoreOptions {
  pool: GovernancePgPool;
  tablePrefix?: string;
}

function rowToDraft(row: Record<string, unknown>): PlatformDemoSessionDraft {
  const draftRaw = row.draft_json;
  const draft =
    draftRaw && typeof draftRaw === 'object' && !Array.isArray(draftRaw)
      ? { ...(draftRaw as Record<string, unknown>) }
      : {};
  return {
    sessionKey: String(row.session_key),
    actorUserId: String(row.actor_user_id),
    actorTenantId: String(row.actor_tenant_id),
    sectionId: String(row.section_id),
    draft,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at),
  };
}

/** Postgres-backed demo_session drafts (v49 table). */
export class PgPlatformDemoSessionStore implements PlatformDemoSessionStore {
  readonly sessionsTable: string;

  constructor(private readonly options: PgPlatformDemoSessionStoreOptions) {
    const prefix = governanceTablePrefix(options.tablePrefix);
    this.sessionsTable = `${prefix}_platform_demo_sessions`;
  }

  async get(
    actorUserId: string,
    actorTenantId: string,
    sectionId: string,
    now: Date = new Date(),
  ): Promise<PlatformDemoSessionDraft | null> {
    const sessionKey = platformDemoSessionKey(actorUserId, actorTenantId, sectionId);
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.sessionsTable}
       WHERE session_key=$1
         AND actor_user_id=$2
         AND actor_tenant_id=$3
         AND expires_at > $4
       LIMIT 1`,
      [sessionKey, actorUserId, actorTenantId, now],
    );
    const row = result.rows[0];
    return row ? rowToDraft(row) : null;
  }

  async save(input: {
    actorUserId: string;
    actorTenantId: string;
    sectionId: string;
    draft: Record<string, unknown>;
    now?: Date;
    ttlMs?: number;
  }): Promise<PlatformDemoSessionDraft> {
    const now = input.now ?? new Date();
    const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
    const sessionKey = platformDemoSessionKey(input.actorUserId, input.actorTenantId, input.sectionId);
    const expiresAt = new Date(now.getTime() + ttlMs);
    const result = await this.options.pool.query(
      `INSERT INTO ${this.sessionsTable} (
         session_key, actor_user_id, actor_tenant_id, section_id, draft_json, updated_at, expires_at
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
       ON CONFLICT (session_key) DO UPDATE SET
         draft_json = EXCLUDED.draft_json,
         updated_at = EXCLUDED.updated_at,
         expires_at = EXCLUDED.expires_at,
         actor_user_id = EXCLUDED.actor_user_id,
         actor_tenant_id = EXCLUDED.actor_tenant_id,
         section_id = EXCLUDED.section_id
       RETURNING *`,
      [
        sessionKey,
        input.actorUserId,
        input.actorTenantId,
        input.sectionId,
        JSON.stringify(input.draft),
        now,
        expiresAt,
      ],
    );
    return rowToDraft(result.rows[0]);
  }

  async clearExpired(now: Date = new Date()): Promise<number> {
    const result = await this.options.pool.query(
      `DELETE FROM ${this.sessionsTable} WHERE expires_at <= $1`,
      [now],
    );
    return result.rowCount ?? 0;
  }
}
