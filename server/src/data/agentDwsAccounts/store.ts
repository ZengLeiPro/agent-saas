import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import { PgGovernanceMigrationRunner, governanceTablePrefix } from '../governance-schema/index.js';
import {
  AgentDwsAccountInvariantError,
  type AgentDwsAccountRecord,
  type AgentDwsAuthorizedProfile,
  type CreateAgentDwsAccountInput,
} from './types.js';

export interface AgentDwsAccountStore {
  init(): Promise<void>;
  listForTenant(tenantId: string): Promise<AgentDwsAccountRecord[]>;
  listRunnable(): Promise<AgentDwsAccountRecord[]>;
  getForTenant(tenantId: string, accountId: string): Promise<AgentDwsAccountRecord | null>;
  deleteForTenant(tenantId: string): Promise<number>;
  create(input: CreateAgentDwsAccountInput): Promise<AgentDwsAccountRecord>;
  markAuthorizing(tenantId: string, accountId: string, expectedRevision: number, updatedBy: string): Promise<AgentDwsAccountRecord>;
  markAuthorized(tenantId: string, accountId: string, expectedRevision: number, profile: AgentDwsAuthorizedProfile, updatedBy: string): Promise<AgentDwsAccountRecord>;
  markAuthorizationFailed(tenantId: string, accountId: string, expectedRevision: number, error: string, updatedBy: string): Promise<void>;
  setEnabled(tenantId: string, accountId: string, enabled: boolean, expectedRevision: number, updatedBy: string): Promise<AgentDwsAccountRecord>;
  claimRuntimeLease(accountId: string, leaseOwner: string, leaseTtlMs: number): Promise<boolean>;
  renewRuntimeLease(accountId: string, leaseOwner: string, leaseTtlMs: number): Promise<boolean>;
  releaseRuntimeLease(accountId: string, leaseOwner: string): Promise<void>;
  revokeRuntimeLease(accountId: string): Promise<void>;
  updateRuntimeStatus(accountId: string, status: AgentDwsAccountRecord['runtimeStatus'], error?: string, leaseOwner?: string): Promise<void>;
  markEvent(accountId: string, leaseOwner: string, occurredAt?: Date): Promise<boolean>;
}

type PgPool = pg.Pool;

export class PgAgentDwsAccountStore implements AgentDwsAccountStore {
  readonly table: string;
  private readonly managedAgentsTable: string;
  private readonly tablePrefix: string;

  constructor(private readonly pool: PgPool, tablePrefix?: string) {
    this.tablePrefix = governanceTablePrefix(tablePrefix);
    this.table = `${this.tablePrefix}_agent_dws_accounts`;
    this.managedAgentsTable = `${this.tablePrefix}_managed_agents`;
  }

  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(this.pool, this.tablePrefix).run();
  }

  async listForTenant(tenantId: string): Promise<AgentDwsAccountRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.table} WHERE tenant_id=$1 ORDER BY updated_at DESC, account_id`,
      [tenantId],
    );
    return result.rows.map(mapRow);
  }

  async listRunnable(): Promise<AgentDwsAccountRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.table}
       WHERE status='active' AND profile_id IS NOT NULL
       ORDER BY updated_at, account_id`,
    );
    return result.rows.map(mapRow);
  }

  async getForTenant(tenantId: string, accountId: string): Promise<AgentDwsAccountRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.table} WHERE tenant_id=$1 AND account_id=$2`,
      [tenantId, accountId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async deleteForTenant(tenantId: string): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM ${this.table} WHERE tenant_id=$1`,
      [tenantId],
    );
    return result.rowCount ?? 0;
  }

  async create(input: CreateAgentDwsAccountInput): Promise<AgentDwsAccountRecord> {
    const accountId = `adws-${randomUUID()}`;
    try {
      const result = await this.pool.query(`
        INSERT INTO ${this.table} (
          account_id,tenant_id,agent_id,display_name,login_id,corp_id,status,
          event_policy_json,created_by,updated_by
        )
        SELECT $1,$2,$3,$4,$5,$6,'draft',$7::jsonb,$8,$8
        FROM ${this.managedAgentsTable}
        WHERE agent_id=$3 AND tenant_id=$2 AND kind='org_agent' AND status <> 'archived'
        RETURNING *
      `, [
        accountId,
        input.tenantId,
        input.agentId,
        input.displayName,
        input.loginId,
        input.corpId ?? null,
        JSON.stringify({ kinds: input.eventKinds }),
        input.createdBy,
      ]);
      if (!result.rows[0]) throw new AgentDwsAccountInvariantError('AGENT_DWS_ACCOUNT_AGENT_INVALID');
      return mapRow(result.rows[0]);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new AgentDwsAccountInvariantError('AGENT_DWS_ACCOUNT_CONFLICT');
      }
      throw error;
    }
  }

  async markAuthorizing(
    tenantId: string,
    accountId: string,
    expectedRevision: number,
    updatedBy: string,
  ): Promise<AgentDwsAccountRecord> {
    const result = await this.pool.query(`
      UPDATE ${this.table}
      SET status='authorizing',runtime_status='stopped',last_error=NULL,
          runtime_lease_owner=NULL,runtime_lease_expires_at=NULL,
          revision=revision+1,updated_at=NOW(),updated_by=$4
      WHERE tenant_id=$1 AND account_id=$2 AND revision=$3
        AND status NOT IN ('paused','authorizing')
      RETURNING *
    `, [tenantId, accountId, expectedRevision, updatedBy]);
    return await this.requireUpdated(result.rows[0], tenantId, accountId);
  }

  async markAuthorized(
    tenantId: string,
    accountId: string,
    expectedRevision: number,
    profile: AgentDwsAuthorizedProfile,
    updatedBy: string,
  ): Promise<AgentDwsAccountRecord> {
    const result = await this.pool.query(`
      UPDATE ${this.table}
      SET profile_id=$4,corp_id=COALESCE(corp_id,$4),corp_name=$5,
          dingtalk_user_id=$6,dingtalk_user_name=$7,status='active',
          runtime_status='stopped',last_error=NULL,revision=revision+1,
          updated_at=NOW(),updated_by=$8
      WHERE tenant_id=$1 AND account_id=$2 AND revision=$3 AND status='authorizing'
      RETURNING *
    `, [
      tenantId,
      accountId,
      expectedRevision,
      profile.profileId,
      profile.corpName ?? null,
      profile.dingtalkUserId ?? null,
      profile.dingtalkUserName ?? null,
      updatedBy,
    ]);
    return await this.requireUpdated(result.rows[0], tenantId, accountId);
  }

  async markAuthorizationFailed(
    tenantId: string,
    accountId: string,
    expectedRevision: number,
    error: string,
    updatedBy: string,
  ): Promise<void> {
    await this.pool.query(`
      UPDATE ${this.table}
      SET status='error',runtime_status='error',last_error=$4,
          revision=revision+1,updated_at=NOW(),updated_by=$5
      WHERE tenant_id=$1 AND account_id=$2 AND revision=$3 AND status='authorizing'
    `, [tenantId, accountId, expectedRevision, compactError(error), updatedBy]);
  }

  async setEnabled(
    tenantId: string,
    accountId: string,
    enabled: boolean,
    expectedRevision: number,
    updatedBy: string,
  ): Promise<AgentDwsAccountRecord> {
    const result = await this.pool.query(`
      UPDATE ${this.table}
      SET status=CASE
            WHEN $4::boolean AND profile_id IS NOT NULL THEN 'active'
            WHEN $4::boolean THEN 'draft'
            ELSE 'paused'
          END,
          runtime_status='stopped',last_error=NULL,
          runtime_lease_owner=NULL,runtime_lease_expires_at=NULL,
          revision=revision+1,updated_at=NOW(),updated_by=$5
      WHERE tenant_id=$1 AND account_id=$2 AND revision=$3
      RETURNING *
    `, [tenantId, accountId, expectedRevision, enabled, updatedBy]);
    return await this.requireUpdated(result.rows[0], tenantId, accountId);
  }

  async claimRuntimeLease(accountId: string, leaseOwner: string, leaseTtlMs: number): Promise<boolean> {
    const result = await this.pool.query(`
      UPDATE ${this.table}
      SET runtime_lease_owner=$2,
          runtime_lease_expires_at=NOW()+($3::bigint * INTERVAL '1 millisecond')
      WHERE account_id=$1 AND status='active' AND profile_id IS NOT NULL
        AND (runtime_lease_owner IS NULL OR runtime_lease_expires_at <= NOW())
      RETURNING account_id
    `, [accountId, leaseOwner, leaseTtlMs]);
    return Boolean(result.rows[0]);
  }

  async renewRuntimeLease(accountId: string, leaseOwner: string, leaseTtlMs: number): Promise<boolean> {
    const result = await this.pool.query(`
      UPDATE ${this.table}
      SET runtime_lease_expires_at=NOW()+($3::bigint * INTERVAL '1 millisecond')
      WHERE account_id=$1 AND runtime_lease_owner=$2 AND status='active'
      RETURNING account_id
    `, [accountId, leaseOwner, leaseTtlMs]);
    return Boolean(result.rows[0]);
  }

  async releaseRuntimeLease(accountId: string, leaseOwner: string): Promise<void> {
    await this.pool.query(`
      UPDATE ${this.table}
      SET runtime_lease_owner=NULL,runtime_lease_expires_at=NULL
      WHERE account_id=$1 AND runtime_lease_owner=$2
    `, [accountId, leaseOwner]);
  }

  async revokeRuntimeLease(accountId: string): Promise<void> {
    await this.pool.query(`
      UPDATE ${this.table}
      SET runtime_lease_owner=NULL,runtime_lease_expires_at=NULL,runtime_status='stopped'
      WHERE account_id=$1
    `, [accountId]);
  }

  async updateRuntimeStatus(
    accountId: string,
    status: AgentDwsAccountRecord['runtimeStatus'],
    error?: string,
    leaseOwner?: string,
  ): Promise<void> {
    await this.pool.query(`
      UPDATE ${this.table}
      SET runtime_status=$2,last_error=$3,updated_at=NOW()
      WHERE account_id=$1 AND ($4::text IS NULL OR runtime_lease_owner=$4)
    `, [accountId, status, error ? compactError(error) : null, leaseOwner ?? null]);
  }

  async markEvent(accountId: string, leaseOwner: string, occurredAt = new Date()): Promise<boolean> {
    const result = await this.pool.query(`
      UPDATE ${this.table}
      SET last_event_at=$3,runtime_status='ready',last_error=NULL,updated_at=NOW()
      WHERE account_id=$1 AND runtime_lease_owner=$2 AND runtime_lease_expires_at > NOW()
      RETURNING account_id
    `, [accountId, leaseOwner, occurredAt.toISOString()]);
    return Boolean(result.rows[0]);
  }

  private async requireUpdated(
    row: Record<string, unknown> | undefined,
    tenantId: string,
    accountId: string,
  ): Promise<AgentDwsAccountRecord> {
    if (row) return mapRow(row);
    const current = await this.getForTenant(tenantId, accountId);
    if (!current) throw new AgentDwsAccountInvariantError('AGENT_DWS_ACCOUNT_NOT_FOUND');
    throw new AgentDwsAccountInvariantError('AGENT_DWS_ACCOUNT_REVISION_CONFLICT');
  }
}

function mapRow(row: Record<string, unknown>): AgentDwsAccountRecord {
  const policy = objectValue(row.event_policy_json);
  const rawKinds = Array.isArray(policy.kinds) ? policy.kinds : [];
  const eventKinds = rawKinds.filter((kind): kind is AgentDwsAccountRecord['eventKinds'][number] => (
    kind === 'at_me' || kind === 'all_direct'
  ));
  return {
    accountId: String(row.account_id),
    tenantId: String(row.tenant_id),
    agentId: String(row.agent_id),
    displayName: String(row.display_name),
    loginId: String(row.login_id),
    ...(text(row.corp_id) ? { corpId: text(row.corp_id) } : {}),
    ...(text(row.corp_name) ? { corpName: text(row.corp_name) } : {}),
    ...(text(row.dingtalk_user_id) ? { dingtalkUserId: text(row.dingtalk_user_id) } : {}),
    ...(text(row.dingtalk_user_name) ? { dingtalkUserName: text(row.dingtalk_user_name) } : {}),
    ...(text(row.profile_id) ? { profileId: text(row.profile_id) } : {}),
    status: String(row.status) as AgentDwsAccountRecord['status'],
    runtimeStatus: String(row.runtime_status) as AgentDwsAccountRecord['runtimeStatus'],
    eventKinds: eventKinds.length > 0 ? eventKinds : ['at_me', 'all_direct'],
    ...(row.last_event_at ? { lastEventAt: iso(row.last_event_at) } : {}),
    ...(text(row.last_error) ? { lastError: text(row.last_error) } : {}),
    revision: Number(row.revision),
    createdAt: iso(row.created_at),
    createdBy: String(row.created_by),
    updatedAt: iso(row.updated_at),
    updatedBy: String(row.updated_by),
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString();
}

function compactError(error: string): string {
  return error.replace(/\s+/g, ' ').trim().slice(0, 500) || 'unknown_error';
}
