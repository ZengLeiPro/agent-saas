import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import { PgGovernanceMigrationRunner, governanceTablePrefix } from '../governance-schema/index.js';
import {
  AGENT_DWS_CONTEXT_POLICY_MAX_CONVERSATIONS,
  AGENT_DWS_CONTEXT_POLICY_MAX_LOOKBACK_DAYS,
  AgentDwsAccountInvariantError,
  failClosedAgentDwsContextPolicy,
  hasExactAgentDwsProfile,
  type AgentDwsAccountRecord,
  type AgentDwsAuthorizedProfile,
  type AgentDwsContextPolicy,
  type AgentDwsContextPolicyMode,
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
  setContextPolicy(
    tenantId: string,
    accountId: string,
    policy: AgentDwsContextPolicy,
    expectedRevision: number,
    updatedBy: string,
  ): Promise<AgentDwsAccountRecord>;
  claimRuntimeLease(accountId: string, leaseOwner: string, leaseTtlMs: number, expectedRevision: number): Promise<boolean>;
  renewRuntimeLease(accountId: string, leaseOwner: string, leaseTtlMs: number, expectedRevision: number): Promise<boolean>;
  releaseRuntimeLease(accountId: string, leaseOwner: string): Promise<void>;
  revokeRuntimeLease(accountId: string): Promise<void>;
  updateRuntimeStatus(
    accountId: string,
    status: AgentDwsAccountRecord['runtimeStatus'],
    error: string | undefined,
    leaseOwner: string | undefined,
    expectedRevision: number,
  ): Promise<void>;
  markEvent(accountId: string, leaseOwner: string, occurredAt: Date, expectedRevision: number): Promise<boolean>;
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
         AND corp_id IS NOT NULL AND dingtalk_user_id IS NOT NULL
         AND profile_id=corp_id || ':' || dingtalk_user_id
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
    if (!hasExactAgentDwsProfile(profile)) {
      throw new AgentDwsAccountInvariantError('AGENT_DWS_ACCOUNT_NOT_AUTHORIZED');
    }
    const result = await this.pool.query(`
      UPDATE ${this.table}
      SET profile_id=$4,corp_id=$5,corp_name=$6,
          dingtalk_user_id=$7,dingtalk_user_name=$8,status='active',
          runtime_status='stopped',last_error=NULL,revision=revision+1,
          identity_updated_at=CASE
            WHEN profile_id IS DISTINCT FROM $4 OR corp_id IS DISTINCT FROM $5
              OR dingtalk_user_id IS DISTINCT FROM $7 THEN NOW()
            ELSE identity_updated_at
          END,
          updated_at=NOW(),updated_by=$9
      WHERE tenant_id=$1 AND account_id=$2 AND revision=$3 AND status='authorizing'
      RETURNING *
    `, [
      tenantId,
      accountId,
      expectedRevision,
      profile.profileId,
      profile.corpId,
      profile.corpName ?? null,
      profile.dingtalkUserId,
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
            WHEN $4::boolean AND profile_id IS NULL THEN 'draft'
            WHEN $4::boolean
              AND corp_id IS NOT NULL AND dingtalk_user_id IS NOT NULL
              AND profile_id=corp_id || ':' || dingtalk_user_id THEN 'active'
            WHEN $4::boolean THEN 'error'
            ELSE 'paused'
          END,
          runtime_status='stopped',
          last_error=CASE
            WHEN $4::boolean AND profile_id IS NOT NULL
              AND (corp_id IS NULL OR dingtalk_user_id IS NULL
                OR profile_id<>corp_id || ':' || dingtalk_user_id)
              THEN 'dws_profile_identity_reauthorization_required'
            ELSE NULL
          END,
          runtime_lease_owner=NULL,runtime_lease_expires_at=NULL,
          revision=revision+1,updated_at=NOW(),updated_by=$5
      WHERE tenant_id=$1 AND account_id=$2 AND revision=$3
      RETURNING *
    `, [tenantId, accountId, expectedRevision, enabled, updatedBy]);
    return await this.requireUpdated(result.rows[0], tenantId, accountId);
  }

  async setContextPolicy(
    tenantId: string,
    accountId: string,
    policy: AgentDwsContextPolicy,
    expectedRevision: number,
    updatedBy: string,
  ): Promise<AgentDwsAccountRecord> {
    const result = await this.pool.query(`
      UPDATE ${this.table}
      SET event_policy_json=jsonb_set(
            COALESCE(event_policy_json,'{}'::jsonb),
            '{contextPolicy}',
            $4::jsonb,
            TRUE
          ),
          revision=revision+1,updated_at=NOW(),updated_by=$5
      WHERE tenant_id=$1 AND account_id=$2 AND revision=$3
      RETURNING *
    `, [tenantId, accountId, expectedRevision, JSON.stringify({
      ...policy,
      effectiveAt: new Date().toISOString(),
    }), updatedBy]);
    return await this.requireUpdated(result.rows[0], tenantId, accountId);
  }

  async claimRuntimeLease(
    accountId: string,
    leaseOwner: string,
    leaseTtlMs: number,
    expectedRevision: number,
  ): Promise<boolean> {
    const result = await this.pool.query(`
      UPDATE ${this.table}
      SET runtime_lease_owner=$2,
          runtime_lease_expires_at=NOW()+($3::bigint * INTERVAL '1 millisecond')
      WHERE account_id=$1 AND revision=$4 AND status='active' AND profile_id IS NOT NULL
        AND corp_id IS NOT NULL AND dingtalk_user_id IS NOT NULL
        AND profile_id=corp_id || ':' || dingtalk_user_id
        AND (runtime_lease_owner IS NULL OR runtime_lease_expires_at <= NOW())
      RETURNING account_id
    `, [accountId, leaseOwner, leaseTtlMs, expectedRevision]);
    return Boolean(result.rows[0]);
  }

  async renewRuntimeLease(
    accountId: string,
    leaseOwner: string,
    leaseTtlMs: number,
    expectedRevision: number,
  ): Promise<boolean> {
    const result = await this.pool.query(`
      UPDATE ${this.table}
      SET runtime_lease_expires_at=NOW()+($3::bigint * INTERVAL '1 millisecond')
      WHERE account_id=$1 AND revision=$4 AND runtime_lease_owner=$2 AND status='active'
      RETURNING account_id
    `, [accountId, leaseOwner, leaseTtlMs, expectedRevision]);
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
    error: string | undefined,
    leaseOwner: string | undefined,
    expectedRevision: number,
  ): Promise<void> {
    await this.pool.query(`
      UPDATE ${this.table}
      SET runtime_status=$2,last_error=$3,updated_at=NOW()
      WHERE account_id=$1 AND revision=$5 AND ($4::text IS NULL OR runtime_lease_owner=$4)
    `, [accountId, status, error ? compactError(error) : null, leaseOwner ?? null, expectedRevision]);
  }

  async markEvent(
    accountId: string,
    leaseOwner: string,
    occurredAt: Date,
    expectedRevision: number,
  ): Promise<boolean> {
    const result = await this.pool.query(`
      UPDATE ${this.table}
      SET last_event_at=$3,runtime_status='ready',last_error=NULL,updated_at=NOW()
      WHERE account_id=$1 AND revision=$4
        AND runtime_lease_owner=$2 AND runtime_lease_expires_at > NOW()
      RETURNING account_id
    `, [accountId, leaseOwner, occurredAt.toISOString(), expectedRevision]);
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
    contextPolicy: parseContextPolicy(policy.contextPolicy),
    ...(row.last_event_at ? { lastEventAt: iso(row.last_event_at) } : {}),
    ...(text(row.last_error) ? { lastError: text(row.last_error) } : {}),
    revision: Number(row.revision),
    createdAt: iso(row.created_at),
    createdBy: String(row.created_by),
    ...(row.identity_updated_at ? { identityUpdatedAt: iso(row.identity_updated_at) } : {}),
    updatedAt: iso(row.updated_at),
    updatedBy: String(row.updated_by),
  };
}

function parseContextPolicy(value: unknown): AgentDwsContextPolicy {
  const policy = objectValue(value);
  const historical = parseSelection(policy.historical, true);
  const realtime = parseSelection(policy.realtime, false);
  if (!historical || !realtime) return failClosedAgentDwsContextPolicy();
  const effectiveAt = optionalIsoText(policy.effectiveAt);
  const realtimeEffectiveAt = parseRealtimeEffectiveAt(policy.realtimeEffectiveAt);
  return {
    historical: { ...historical.selection, lookbackDays: historical.lookbackDays! },
    realtime: realtime.selection,
    wiki: { enabled: objectValue(policy.wiki).enabled === true },
    minutes: parseMinutesPolicy(policy.minutes),
    ...(realtimeEffectiveAt ? { realtimeEffectiveAt } : {}),
    ...(effectiveAt ? { effectiveAt } : {}),
  };
}

function parseRealtimeEffectiveAt(
  value: unknown,
): AgentDwsContextPolicy['realtimeEffectiveAt'] | undefined {
  const input = objectValue(value);
  const all = optionalIsoText(input.all);
  const rawConversations = objectValue(input.conversations);
  const conversations: Record<string, string> = {};
  for (const [conversationId, timestamp] of Object.entries(rawConversations)) {
    const parsed = optionalIsoText(timestamp);
    if (conversationId.length > 256 || !conversationId.trim() || !parsed) continue;
    conversations[conversationId] = parsed;
  }
  if (!all && Object.keys(conversations).length === 0) return undefined;
  return { ...(all ? { all } : {}), ...(Object.keys(conversations).length ? { conversations } : {}) };
}

function parseMinutesPolicy(value: unknown): { enabled: boolean; lookbackDays: number } {
  const input = objectValue(value);
  const lookbackDays = Number(input.lookbackDays);
  return {
    enabled: input.enabled === true
      && Number.isSafeInteger(lookbackDays)
      && lookbackDays >= 1
      && lookbackDays <= AGENT_DWS_CONTEXT_POLICY_MAX_LOOKBACK_DAYS,
    lookbackDays: Number.isSafeInteger(lookbackDays)
      && lookbackDays >= 1
      && lookbackDays <= AGENT_DWS_CONTEXT_POLICY_MAX_LOOKBACK_DAYS
      ? lookbackDays
      : 30,
  };
}

function parseSelection(value: unknown, historical: boolean): {
  selection: { mode: AgentDwsContextPolicyMode; conversationIds: string[] };
  lookbackDays?: number;
} | null {
  const input = objectValue(value);
  const mode = input.mode;
  if (mode !== 'none' && mode !== 'selected' && mode !== 'all') return null;
  if (!Array.isArray(input.conversationIds)
    || input.conversationIds.length > AGENT_DWS_CONTEXT_POLICY_MAX_CONVERSATIONS) return null;
  const conversationIds = input.conversationIds.map(item => (
    typeof item === 'string' && item === item.trim() && item.length > 0 && item.length <= 256 ? item : null
  ));
  if (conversationIds.some(item => item === null)) return null;
  const ids = conversationIds as string[];
  if (new Set(ids).size !== ids.length) return null;
  if ((mode === 'selected') !== (ids.length > 0)) return null;
  if (historical && (!Number.isSafeInteger(input.lookbackDays)
    || Number(input.lookbackDays) < 1
    || Number(input.lookbackDays) > AGENT_DWS_CONTEXT_POLICY_MAX_LOOKBACK_DAYS)) return null;
  return {
    selection: { mode, conversationIds: ids },
    ...(historical ? { lookbackDays: Number(input.lookbackDays) } : {}),
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalIsoText(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString();
}

function compactError(error: string): string {
  return error.replace(/\s+/g, ' ').trim().slice(0, 500) || 'unknown_error';
}
