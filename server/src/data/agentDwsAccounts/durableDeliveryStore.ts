import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { governanceTablePrefix, PgGovernanceMigrationRunner } from '../governance-schema/index.js';
import type { AgentDwsAccountRecord } from './types.js';
import { classifyDwsIntake } from '../../dws/durableEventValidation.js';
import {
  decodeDwsSpoolFrame, DWS_RECEIVER_LIMITS, DwsReceiverProtocolError, parseDwsReceiverOwner,
  parseDwsReceiverRequest, type DwsReceiverOwner, type DwsReceiverSource,
  type DwsReceiverWorkspace, type DwsSpoolFrame,
} from '../../runtime/dwsReceiverProtocol.js';

export interface DwsDeliverySession {
  owner: DwsReceiverOwner;
  source: DwsReceiverSource;
  workspace: DwsReceiverWorkspace;
  receivedCursor: number;
  acknowledgedCursor: number;
  state: string;
}

export interface PendingDwsIntake {
  sequence: number;
  bytes: Buffer;
  identity: DwsReceiverSource;
}

export interface DwsReceiverMigrationRecord {
  migrationId: string;
  accountId: string;
  tenantId: string;
  expectedRevision: number;
  state: 'planned' | 'handoff_pending' | 'blocked' | 'activated' | 'aborted';
  evidence: Record<string, unknown>;
}

export interface PrepareDwsReceiverMigration {
  account: AgentDwsAccountRecord;
  receiverId: string;
  source: DwsReceiverSource;
  workspace: DwsReceiverWorkspace;
  actor: string;
  evidence: Record<string, unknown>;
}

type Row = Record<string, unknown>;

/** PostgreSQL owns consumer authority. The remote account lock owns the source. */
export class PgDwsDeliveryStore {
  readonly ownersTable: string;
  readonly inboxTable: string;
  readonly accountsTable: string;
  readonly migrationsTable: string;
  private readonly prefix: string;

  constructor(readonly pool: pg.Pool, tablePrefix?: string) {
    this.prefix = governanceTablePrefix(tablePrefix);
    this.ownersTable = `${this.prefix}_dws_receiver_owners`;
    this.inboxTable = `${this.prefix}_dws_receiver_inbox`;
    this.accountsTable = `${this.prefix}_agent_dws_accounts`;
    this.migrationsTable = `${this.prefix}_dws_receiver_migrations`;
  }

  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(this.pool, this.prefix).run();
  }

  async registration(tenantId: string, accountId: string): Promise<{
    source: DwsReceiverSource; workspace: DwsReceiverWorkspace; state: string;
  } | null> {
    const result = await this.pool.query(`SELECT source_json,workspace_json,state
      FROM ${this.ownersTable} WHERE tenant_id=$1 AND account_id=$2`, [tenantId, accountId]);
    const row = result.rows[0];
    return row ? { source: row.source_json, workspace: row.workspace_json, state: row.state } : null;
  }

  async prepareMigration(input: PrepareDwsReceiverMigration): Promise<DwsReceiverMigrationRecord> {
    return this.transaction(async client => {
      const account = await client.query(`SELECT * FROM ${this.accountsTable}
        WHERE tenant_id=$1 AND account_id=$2 FOR UPDATE`, [input.account.tenantId, input.account.accountId]);
      const row = account.rows[0];
      const policy = row?.event_policy_json as Record<string, unknown> | undefined;
      if (!row || Number(row.revision) !== input.account.revision) throw new DwsReceiverProtocolError('migration_revision_conflict');
      if (row.status !== 'active' || row.profile_id !== input.source.profileId
        || new Date(row.identity_updated_at as string | Date).toISOString() !== input.source.identityUpdatedAt
        || policy?.identityCleanupPending || (policy?.deliveryProtocol !== undefined && policy.deliveryProtocol !== 'legacy')) {
        throw new DwsReceiverProtocolError('migration_legacy_identity_required');
      }
      const active = await client.query(`SELECT migration_id FROM ${this.migrationsTable}
        WHERE account_id=$1 AND state IN ('planned','handoff_pending','blocked')`, [input.account.accountId]);
      if (active.rows[0]) throw new DwsReceiverProtocolError('migration_already_active');
      const migrationId = `drm-${randomUUID()}`;
      await client.query(`INSERT INTO ${this.ownersTable}
        (account_id,tenant_id,receiver_id,source_json,workspace_json,account_revision,bridge_evidence_json)
        VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7::jsonb)`, [input.account.accountId,
        input.account.tenantId, input.receiverId, JSON.stringify(input.source), JSON.stringify(input.workspace),
        input.account.revision, JSON.stringify(input.evidence)]);
      const result = await client.query(`INSERT INTO ${this.migrationsTable}
        (migration_id,account_id,tenant_id,expected_revision,state,evidence_json,created_by)
        VALUES ($1,$2,$3,$4,'planned',$5::jsonb,$6) RETURNING *`, [migrationId, input.account.accountId,
        input.account.tenantId, input.account.revision, JSON.stringify(input.evidence), input.actor]);
      return migrationRecord(result.rows[0]);
    });
  }

  async beginMigration(migrationId: string): Promise<DwsReceiverMigrationRecord> {
    return this.transaction(async client => {
      const migration = await this.lockMigration(client, migrationId);
      if (migration.state !== 'planned') throw new DwsReceiverProtocolError('migration_not_planned');
      const account = await client.query(`SELECT * FROM ${this.accountsTable}
        WHERE tenant_id=$1 AND account_id=$2 FOR UPDATE`, [migration.tenant_id, migration.account_id]);
      const row = account.rows[0];
      const policy = row?.event_policy_json as Record<string, unknown> | undefined;
      if (!row || Number(row.revision) !== Number(migration.expected_revision)
        || (policy?.deliveryProtocol !== undefined && policy.deliveryProtocol !== 'legacy')) {
        throw new DwsReceiverProtocolError('migration_revision_conflict');
      }
      const nextRevision = Number(row.revision) + 1;
      await client.query(`UPDATE ${this.accountsTable}
        SET event_policy_json=jsonb_set(COALESCE(event_policy_json,'{}'::jsonb),'{deliveryProtocol}',
          '"handoff_pending"'::jsonb,TRUE),runtime_status='stopped',runtime_lease_owner=NULL,
          runtime_lease_expires_at=NULL,revision=$2,updated_at=clock_timestamp()
        WHERE account_id=$1`, [migration.account_id, nextRevision]);
      await client.query(`UPDATE ${this.ownersTable} SET account_revision=$2,updated_at=clock_timestamp()
        WHERE account_id=$1 AND state='registered' AND owner_id IS NULL`, [migration.account_id, nextRevision]);
      const result = await client.query(`UPDATE ${this.migrationsTable}
        SET state='handoff_pending',updated_at=clock_timestamp() WHERE migration_id=$1 RETURNING *`, [migrationId]);
      return migrationRecord(result.rows[0]);
    });
  }

  async blockMigration(migrationId: string, evidence: Record<string, unknown>): Promise<void> {
    await this.pool.query(`UPDATE ${this.migrationsTable}
      SET state='blocked',evidence_json=evidence_json || $2::jsonb,updated_at=clock_timestamp()
      WHERE migration_id=$1 AND state IN ('handoff_pending','blocked')`, [migrationId, JSON.stringify(evidence)]);
  }

  async activateMigration(migrationId: string, evidence: Record<string, unknown>): Promise<DwsReceiverMigrationRecord> {
    return this.transaction(async client => {
      const migration = await this.lockMigration(client, migrationId);
      if (!['handoff_pending', 'blocked'].includes(String(migration.state))) {
        throw new DwsReceiverProtocolError('migration_not_handoff_pending');
      }
      const account = await client.query(`SELECT * FROM ${this.accountsTable}
        WHERE tenant_id=$1 AND account_id=$2 FOR UPDATE`, [migration.tenant_id, migration.account_id]);
      const owner = await client.query(`SELECT * FROM ${this.ownersTable} WHERE account_id=$1 FOR UPDATE`, [migration.account_id]);
      const row = account.rows[0];
      const registration = owner.rows[0];
      if (!row || row.event_policy_json?.deliveryProtocol !== 'handoff_pending' || !registration
        || Number(registration.account_revision) !== Number(row.revision) || registration.owner_id !== null
        || Number(registration.received_cursor) !== 0 || Number(registration.acknowledged_cursor) !== 0
        || registration.state !== 'registered') throw new DwsReceiverProtocolError('migration_activation_fence_failed');
      const nextRevision = Number(row.revision) + 1;
      await client.query(`UPDATE ${this.accountsTable}
        SET event_policy_json=jsonb_set(event_policy_json,'{deliveryProtocol}','"durable-v1"'::jsonb,TRUE),
          revision=$2,updated_at=clock_timestamp() WHERE account_id=$1`, [migration.account_id, nextRevision]);
      await client.query(`UPDATE ${this.ownersTable}
        SET account_revision=$2,bridge_evidence_json=bridge_evidence_json || $3::jsonb,updated_at=clock_timestamp()
        WHERE account_id=$1`, [migration.account_id, nextRevision, JSON.stringify(evidence)]);
      const result = await client.query(`UPDATE ${this.migrationsTable}
        SET state='activated',evidence_json=evidence_json || $2::jsonb,updated_at=clock_timestamp()
        WHERE migration_id=$1 RETURNING *`, [migrationId, JSON.stringify(evidence)]);
      return migrationRecord(result.rows[0]);
    });
  }

  async migration(tenantId: string, accountId: string): Promise<DwsReceiverMigrationRecord | null> {
    const result = await this.pool.query(`SELECT * FROM ${this.migrationsTable}
      WHERE tenant_id=$1 AND account_id=$2 ORDER BY created_at DESC LIMIT 1`, [tenantId, accountId]);
    return result.rows[0] ? migrationRecord(result.rows[0]) : null;
  }

  async abortPlannedMigration(migrationId: string, actor: string): Promise<DwsReceiverMigrationRecord> {
    return this.transaction(async client => {
      const migration = await this.lockMigration(client, migrationId);
      if (migration.state !== 'planned') throw new DwsReceiverProtocolError('migration_abort_unsafe');
      await client.query(`DELETE FROM ${this.ownersTable} WHERE account_id=$1 AND owner_id IS NULL
        AND state='registered' AND received_cursor=0 AND acknowledged_cursor=0`, [migration.account_id]);
      const result = await client.query(`UPDATE ${this.migrationsTable}
        SET state='aborted',evidence_json=evidence_json || jsonb_build_object('abortedBy',$2::text),
          updated_at=clock_timestamp() WHERE migration_id=$1 RETURNING *`, [migrationId, actor]);
      return migrationRecord(result.rows[0]);
    });
  }

  async claim(account: AgentDwsAccountRecord, ownerId: string, purpose: 'consume' | 'stop' = 'consume'): Promise<DwsDeliverySession | null> {
    return this.transaction(async client => {
      const row = await this.lockAccount(client, account.tenantId, account.accountId);
      if (Number(row.current_revision) !== account.revision) throw new DwsReceiverProtocolError('account_revision_changed');
      this.assertAccount(row, purpose);
      if (purpose === 'consume' && row.owner_id && Number(row.lease_remaining_ms) > 0) return null;
      // Explicit stop revokes the prior consumer by advancing the epoch under
      // the same row locks that every ingestion transaction must acquire.
      const result = await client.query(`UPDATE ${this.ownersTable}
        SET owner_epoch=owner_epoch+1,owner_id=$2,account_revision=$3,
          lease_expires_at=clock_timestamp()+INTERVAL '60 seconds',
          state=CASE WHEN $4='stop' THEN 'stopping' ELSE state END,updated_at=clock_timestamp()
        WHERE account_id=$1 AND owner_epoch < 9223372036854775807
        RETURNING *, EXTRACT(EPOCH FROM lease_expires_at)*1000 AS expires_at_ms`,
      [account.accountId, ownerId, account.revision, purpose]);
      if (!result.rows[0]) throw new DwsReceiverProtocolError('owner_epoch_exhausted');
      return this.session(result.rows[0]);
    });
  }

  async renew(owner: DwsReceiverOwner, purpose: 'consume' | 'stop' = 'consume'): Promise<DwsReceiverOwner> {
    return this.fenced(owner, async client => {
      const result = await client.query(`UPDATE ${this.ownersTable}
        SET lease_expires_at=clock_timestamp()+INTERVAL '60 seconds',updated_at=clock_timestamp()
        WHERE account_id=$1 RETURNING *, EXTRACT(EPOCH FROM lease_expires_at)*1000 AS expires_at_ms`, [owner.accountId]);
      return this.session(result.rows[0]).owner;
    }, purpose);
  }

  async release(owner: DwsReceiverOwner): Promise<void> {
    // Releasing a consumer never deletes source identity, cursor, data or epoch.
    await this.pool.query(`UPDATE ${this.ownersTable}
      SET owner_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
      WHERE account_id=$1 AND tenant_id=$2 AND owner_id=$3 AND owner_epoch=$4::bigint AND account_revision=$5`,
    [owner.accountId, owner.tenantId, owner.ownerId, owner.epoch, owner.revision]);
  }

  async accept(owner: DwsReceiverOwner, frames: DwsSpoolFrame[]): Promise<number> {
    if (frames.length > DWS_RECEIVER_LIMITS.pageRecords
      || Buffer.byteLength(JSON.stringify(frames)) > DWS_RECEIVER_LIMITS.pageBytes) {
      throw new DwsReceiverProtocolError('intake_page_limit');
    }
    const decoded = frames.map(decodeDwsSpoolFrame);
    return this.fenced(owner, async (client, row) => {
      let cursor = safeCursor(row.received_cursor);
      // Only data already forwarded to the durable business inbox AND confirmed
      // ACKed by the remote source is eligible for automatic retention cleanup.
      await client.query(`DELETE FROM ${this.inboxTable} WHERE account_id=$1 AND receiver_id=$2
        AND state='forwarded' AND sequence <= $3 AND forwarded_at < clock_timestamp()-INTERVAL '7 days'`,
      [owner.accountId, owner.receiverId, row.acknowledged_cursor]);
      const quota = await client.query(`SELECT COUNT(*)::text AS records,
        COALESCE(SUM(octet_length(payload)),0)::text AS bytes
        FROM ${this.inboxTable} WHERE account_id=$1`, [owner.accountId]);
      let records = Number(quota.rows[0].records);
      let bytes = Number(quota.rows[0].bytes);
      let lastSequence: number | undefined;
      for (const candidate of decoded) {
        const { frame } = candidate;
        if (lastSequence !== undefined && frame.sequence !== lastSequence + 1) throw new DwsReceiverProtocolError('intake_cursor_gap');
        lastSequence = frame.sequence;
        if (frame.sequence <= cursor) {
          const previous = await client.query(`SELECT payload_sha256 FROM ${this.inboxTable}
            WHERE account_id=$1 AND receiver_id=$2 AND sequence=$3`, [owner.accountId, owner.receiverId, frame.sequence]);
          if (previous.rows[0]?.payload_sha256 !== frame.sha256) throw new DwsReceiverProtocolError('intake_replay_identity_conflict');
          continue;
        }
        if (frame.sequence !== cursor + 1) throw new DwsReceiverProtocolError('intake_cursor_gap');
        records += 1;
        bytes += candidate.bytes.length;
        if (records > DWS_RECEIVER_LIMITS.spoolRecords || bytes > DWS_RECEIVER_LIMITS.spoolBytes) {
          throw new DwsReceiverProtocolError('durable_inbox_quota_exhausted', 503);
        }
        const decision = classifyDwsIntake(candidate.bytes);
        await client.query(`INSERT INTO ${this.inboxTable}
          (account_id,receiver_id,sequence,tenant_id,account_revision,account_identity_json,payload,
           payload_sha256,received_at_ms,event_id,state,reason_code)
          VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12)`,
        [owner.accountId, owner.receiverId, frame.sequence, owner.tenantId, owner.revision,
          JSON.stringify(row.source_json), candidate.bytes, frame.sha256, frame.receivedAtMs,
          decision.eventId ?? null, decision.reason ? 'dead_letter' : 'pending', decision.reason ?? null]);
        cursor = frame.sequence;
      }
      await client.query(`UPDATE ${this.ownersTable}
        SET received_cursor=$2,state=CASE WHEN state='stopping' THEN state ELSE 'receiving' END,
          last_error_code=NULL,updated_at=clock_timestamp() WHERE account_id=$1`, [owner.accountId, cursor]);
      return cursor;
    });
  }

  async acknowledged(owner: DwsReceiverOwner, through: number): Promise<void> {
    safeCursor(through);
    await this.fenced(owner, async (client, row) => {
      if (through > safeCursor(row.received_cursor) || through < safeCursor(row.acknowledged_cursor)) {
        throw new DwsReceiverProtocolError('uncommitted_ack_cursor');
      }
      const uncommitted = await client.query(`SELECT 1 FROM ${this.inboxTable}
        WHERE account_id=$1 AND receiver_id=$2 AND sequence <= $3 AND state='pending' LIMIT 1`,
      [owner.accountId, owner.receiverId, through]);
      if (uncommitted.rows[0]) throw new DwsReceiverProtocolError('uncommitted_ack_cursor');
      await client.query(`UPDATE ${this.ownersTable} SET acknowledged_cursor=$2,updated_at=clock_timestamp()
        WHERE account_id=$1`, [owner.accountId, through]);
    });
  }

  async pending(owner: DwsReceiverOwner): Promise<PendingDwsIntake[]> {
    return this.fenced(owner, async client => {
      const result = await client.query(`SELECT sequence,payload,account_identity_json FROM ${this.inboxTable}
        WHERE account_id=$1 AND receiver_id=$2 AND state='pending'
        ORDER BY sequence LIMIT $3`, [owner.accountId, owner.receiverId, DWS_RECEIVER_LIMITS.pageRecords]);
      return result.rows.map(item => ({ sequence: safeCursor(item.sequence), bytes: item.payload,
        identity: item.account_identity_json as DwsReceiverSource }));
    });
  }

  async updateRuntimeStatus(owner: DwsReceiverOwner, status: AgentDwsAccountRecord['runtimeStatus'], error?: string): Promise<void> {
    if (error !== undefined) validateCode(error);
    await this.fenced(owner, async client => {
      await client.query(`UPDATE ${this.accountsTable}
        SET runtime_status=$2,last_error=$3,updated_at=clock_timestamp()
        WHERE account_id=$1 AND revision=$4`, [owner.accountId, status, error ?? null, owner.revision]);
    });
  }

  async markEvent(owner: DwsReceiverOwner, occurredAt: Date): Promise<void> {
    if (!Number.isFinite(occurredAt.getTime())) throw new DwsReceiverProtocolError('invalid_event_time');
    await this.fenced(owner, async client => {
      await client.query(`UPDATE ${this.accountsTable}
        SET last_event_at=GREATEST(COALESCE(last_event_at,'-infinity'::timestamptz),$2),updated_at=clock_timestamp()
        WHERE account_id=$1 AND revision=$3`, [owner.accountId, occurredAt, owner.revision]);
    });
  }

  async forwarded(owner: DwsReceiverOwner, sequence: number): Promise<void> {
    await this.fenced(owner, async client => {
      await client.query(`UPDATE ${this.inboxTable} SET state='forwarded',forwarded_at=clock_timestamp()
        WHERE account_id=$1 AND receiver_id=$2 AND sequence=$3 AND state='pending'`,
      [owner.accountId, owner.receiverId, safeCursor(sequence)]);
    });
  }

  async ackableCursor(owner: DwsReceiverOwner): Promise<number> {
    return this.fenced(owner, async (client, row) => {
      const result = await client.query(`SELECT MIN(sequence)::text AS first_pending
        FROM ${this.inboxTable} WHERE account_id=$1 AND receiver_id=$2 AND state='pending'
          AND sequence > $3`, [owner.accountId, owner.receiverId, row.acknowledged_cursor]);
      const firstPending = result.rows[0]?.first_pending;
      return firstPending === null || firstPending === undefined
        ? safeCursor(row.received_cursor)
        : safeCursor(firstPending) - 1;
    });
  }

  async deadLetter(owner: DwsReceiverOwner, sequence: number, reasonCode: string): Promise<void> {
    validateCode(reasonCode);
    await this.fenced(owner, async client => {
      await client.query(`UPDATE ${this.inboxTable} SET state='dead_letter',reason_code=$4
        WHERE account_id=$1 AND receiver_id=$2 AND sequence=$3 AND state='pending'`,
      [owner.accountId, owner.receiverId, safeCursor(sequence), reasonCode]);
    });
  }

  async recordBlocker(owner: DwsReceiverOwner, reasonCode: string): Promise<void> {
    validateCode(reasonCode);
    await this.pool.query(`UPDATE ${this.ownersTable} SET last_error_code=$4,updated_at=clock_timestamp()
      WHERE account_id=$1 AND owner_id=$2 AND owner_epoch=$3::bigint`,
    [owner.accountId, owner.ownerId, owner.epoch, reasonCode]);
  }

  async diagnostics(tenantId: string, accountId: string): Promise<Record<string, unknown> | null> {
    const result = await this.pool.query(`SELECT r.receiver_id,r.owner_epoch::text,r.state,
        r.received_cursor::text,r.acknowledged_cursor::text,r.last_error_code,
        (r.lease_expires_at > clock_timestamp()) AS consumer_active,
        COUNT(i.sequence) FILTER (WHERE i.state='pending')::text AS pending,
        COUNT(i.sequence) FILTER (WHERE i.state='dead_letter')::text AS dead_letters
      FROM ${this.ownersTable} r LEFT JOIN ${this.inboxTable} i
        ON i.account_id=r.account_id AND i.receiver_id=r.receiver_id
      WHERE r.tenant_id=$1 AND r.account_id=$2 GROUP BY r.account_id`, [tenantId, accountId]);
    return result.rows[0] ?? null;
  }

  private async transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout='10s'");
      await client.query("SET LOCAL lock_timeout='5s'");
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  private async lockAccount(client: pg.PoolClient, tenantId: string, accountId: string): Promise<Row> {
    const result = await client.query(`SELECT r.*,a.revision AS current_revision,a.status AS account_status,
      a.profile_id,a.identity_updated_at,a.event_policy_json,
      EXTRACT(EPOCH FROM (r.lease_expires_at-clock_timestamp()))*1000 AS lease_remaining_ms
      FROM ${this.ownersTable} r JOIN ${this.accountsTable} a ON a.account_id=r.account_id
      WHERE r.tenant_id=$1 AND r.account_id=$2 AND a.tenant_id=$1 FOR UPDATE OF a,r`, [tenantId, accountId]);
    if (!result.rows[0]) throw new DwsReceiverProtocolError('receiver_registration_required');
    return result.rows[0];
  }

  private async lockMigration(client: pg.PoolClient, migrationId: string): Promise<Row> {
    const result = await client.query(`SELECT * FROM ${this.migrationsTable} WHERE migration_id=$1 FOR UPDATE`, [migrationId]);
    if (!result.rows[0]) throw new DwsReceiverProtocolError('migration_not_found', 404);
    return result.rows[0];
  }

  private assertAccount(row: Row, purpose: 'consume' | 'stop'): void {
    const policy = row.event_policy_json as Record<string, unknown> | null;
    if (!policy || !['durable-v1', 'handoff_pending'].includes(String(policy.deliveryProtocol))) {
      throw new DwsReceiverProtocolError('receiver_account_protocol_changed');
    }
    if (purpose === 'stop') return;
    const source = row.source_json as DwsReceiverSource;
    if (row.account_status !== 'active' || policy.deliveryProtocol !== 'durable-v1' || policy.identityCleanupPending
      || source.profileId !== row.profile_id
      || Date.parse(source.identityUpdatedAt) !== new Date(row.identity_updated_at as string | Date).getTime()) {
      throw new DwsReceiverProtocolError('receiver_account_identity_changed');
    }
    if (row.state === 'stopped' || row.state === 'stopping') throw new DwsReceiverProtocolError('receiver_stopping');
  }

  private async fenced<T>(owner: DwsReceiverOwner, work: (client: pg.PoolClient, row: Row) => Promise<T>, purpose: 'consume' | 'stop' = 'consume'): Promise<T> {
    parseDwsReceiverOwner(owner);
    return this.transaction(async client => {
      const row = await this.lockAccount(client, owner.tenantId, owner.accountId);
      this.assertAccount(row, purpose);
      if (String(row.owner_epoch) !== owner.epoch || row.owner_id !== owner.ownerId
        || row.receiver_id !== owner.receiverId || Number(row.account_revision) !== owner.revision
        || Number(row.current_revision) !== owner.revision || !(Number(row.lease_remaining_ms) > 0)) {
        throw new DwsReceiverProtocolError('stale_consumer_owner');
      }
      const result = await work(client, row);
      // No lease revival through a slow intake transaction. A competing claim
      // serializes on these same rows; ambiguous COMMIT remains retryable by hash.
      const fresh = await client.query(`SELECT 1 FROM ${this.ownersTable}
        WHERE account_id=$1 AND lease_expires_at > clock_timestamp()`, [owner.accountId]);
      if (!fresh.rows[0]) throw new DwsReceiverProtocolError('consumer_lease_expired');
      return result;
    });
  }

  private session(row: Row): DwsDeliverySession {
    const owner = parseDwsReceiverOwner({
      tenantId: row.tenant_id, accountId: row.account_id, receiverId: row.receiver_id,
      ownerId: row.owner_id, epoch: String(row.owner_epoch), revision: Number(row.account_revision),
      expiresAtMs: Math.floor(Number(row.expires_at_ms)),
    });
    const request = parseDwsReceiverRequest({ protocolVersion: 1, action: 'status', owner,
      source: row.source_json, workspace: row.workspace_json });
    return { owner, source: request.source, workspace: request.workspace,
      receivedCursor: safeCursor(row.received_cursor), acknowledgedCursor: safeCursor(row.acknowledged_cursor), state: String(row.state) };
  }
}

function migrationRecord(row: Row): DwsReceiverMigrationRecord {
  return {
    migrationId: String(row.migration_id), accountId: String(row.account_id), tenantId: String(row.tenant_id),
    expectedRevision: Number(row.expected_revision), state: row.state as DwsReceiverMigrationRecord['state'],
    evidence: row.evidence_json as Record<string, unknown>,
  };
}

function safeCursor(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new DwsReceiverProtocolError('invalid_persisted_cursor');
  return number;
}

function validateCode(value: string): void {
  if (!/^[a-z0-9_:-]{1,128}$/.test(value)) throw new DwsReceiverProtocolError('invalid_diagnostic_code');
}
