import { createHash, randomUUID } from 'node:crypto';

import { PgGovernanceMigrationRunner, governanceTablePrefix, type GovernancePgPool } from '../governance-schema/index.js';
import type { OAuthApprovalRecord, OAuthGrant, OAuthGrantProjectionInput } from './types.js';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function grantFromRow(row: Record<string, unknown>): OAuthGrant {
  return {
    grantId: String(row.grant_id), tenantId: String(row.tenant_id), subjectUserId: String(row.subject_user_id),
    provider: String(row.provider), ...(row.connector_id ? { connectorId: String(row.connector_id) } : {}),
    status: row.status as OAuthGrant['status'],
    scopeSummary: Array.isArray(row.scope_summary_json) ? row.scope_summary_json.map(String) : [],
    approvedAt: new Date(String(row.approved_at)).toISOString(),
    ...(row.expires_at ? { expiresAt: new Date(String(row.expires_at)).toISOString() } : {}),
    ...(row.last_used_at ? { lastUsedAt: new Date(String(row.last_used_at)).toISOString() } : {}),
    version: Number(row.version),
    ...(row.revocation_stage ? { revocationStage: row.revocation_stage as OAuthGrant['revocationStage'] } : {}),
    ...(row.revocation_attempt ? { revocationAttempt: Number(row.revocation_attempt) } : {}),
    ...(row.revocation_next_retry_at ? { revocationNextRetryAt: new Date(String(row.revocation_next_retry_at)).toISOString() } : {}),
    ...(row.revocation_last_error_code ? { revocationLastErrorCode: String(row.revocation_last_error_code) } : {}),
  };
}

function approvalFromRow(row: Record<string, unknown>): OAuthApprovalRecord {
  return {
    approvalId: String(row.approval_id), grantId: String(row.grant_id),
    action: row.action as OAuthApprovalRecord['action'],
    scopeSummary: Array.isArray(row.scope_summary_json) ? row.scope_summary_json.map(String) : [],
    purpose: String(row.purpose), actorUserId: String(row.actor_user_id),
    occurredAt: new Date(String(row.occurred_at)).toISOString(),
  };
}

export class PgOAuthGrantStore {
  readonly grantsTable: string;
  readonly approvalsTable: string;
  readonly nativeHandoffsTable: string;

  constructor(private readonly options: { pool: GovernancePgPool; tablePrefix?: string }) {
    const prefix = governanceTablePrefix(options.tablePrefix);
    this.grantsTable = `${prefix}_oauth_grants`;
    this.approvalsTable = `${prefix}_oauth_approval_records`;
    this.nativeHandoffsTable = `${prefix}_native_oauth_handoffs`;
  }

  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(this.options.pool, this.options.tablePrefix).run();
  }

  async getForSubject(tenantId: string, subjectUserId: string, grantId: string): Promise<OAuthGrant | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.grantsTable} WHERE tenant_id=$1 AND subject_user_id=$2 AND grant_id=$3`,
      [tenantId, subjectUserId, grantId],
    );
    return result.rows[0] ? grantFromRow(result.rows[0]) : null;
  }

  async listForSubject(tenantId: string, subjectUserId: string): Promise<Array<OAuthGrant & { approvals: OAuthApprovalRecord[] }>> {
    const [grants, approvals] = await Promise.all([
      this.options.pool.query(
        `SELECT * FROM ${this.grantsTable} WHERE tenant_id=$1 AND subject_user_id=$2 ORDER BY provider,grant_id`,
        [tenantId, subjectUserId],
      ),
      this.options.pool.query(
        `SELECT * FROM ${this.approvalsTable} WHERE tenant_id=$1 AND subject_user_id=$2 ORDER BY occurred_at DESC,approval_id`,
        [tenantId, subjectUserId],
      ),
    ]);
    const approvalsByGrant = new Map<string, OAuthApprovalRecord[]>();
    for (const row of approvals.rows) {
      const approval = approvalFromRow(row);
      const items = approvalsByGrant.get(approval.grantId) ?? [];
      items.push(approval);
      approvalsByGrant.set(approval.grantId, items);
    }
    return grants.rows.map(row => {
      const grant = grantFromRow(row);
      return { ...grant, approvals: approvalsByGrant.get(grant.grantId) ?? [] };
    });
  }

  async beginNativeHandoff(input: {
    providerState: string; userId: string; tenantId: string; connectorId: string; deviceId: string;
    clientState: string; pkceChallenge: string; provider: string; redirectUri: string; identityGeneration: number; createdAt: number;
  }): Promise<void> {
    const result = await this.options.pool.query(
      `INSERT INTO ${this.nativeHandoffsTable} (
         provider_state_hash,user_id,tenant_id,connector_id,device_hash,request_expires_at,
         client_state,client_state_hash,pkce_challenge,callback_provider,redirect_uri,identity_generation
       ) VALUES ($1,$2,$3,$4,$5,NOW()+INTERVAL '10 minutes',$6,$7,$8,$9,$10,$11)
       ON CONFLICT (provider_state_hash) DO UPDATE SET
         request_expires_at=EXCLUDED.request_expires_at,updated_at=NOW()
       WHERE ${this.nativeHandoffsTable}.user_id=EXCLUDED.user_id
         AND ${this.nativeHandoffsTable}.tenant_id=EXCLUDED.tenant_id
         AND ${this.nativeHandoffsTable}.connector_id=EXCLUDED.connector_id
         AND ${this.nativeHandoffsTable}.device_hash=EXCLUDED.device_hash
         AND ${this.nativeHandoffsTable}.client_state_hash=EXCLUDED.client_state_hash
         AND ${this.nativeHandoffsTable}.pkce_challenge=EXCLUDED.pkce_challenge
         AND ${this.nativeHandoffsTable}.callback_provider=EXCLUDED.callback_provider
         AND ${this.nativeHandoffsTable}.redirect_uri=EXCLUDED.redirect_uri
         AND ${this.nativeHandoffsTable}.identity_generation=EXCLUDED.identity_generation
         AND ${this.nativeHandoffsTable}.code_hash IS NULL
         AND ${this.nativeHandoffsTable}.status IS NULL
       RETURNING provider_state_hash`,
      [digest(input.providerState), input.userId, input.tenantId, input.connectorId, digest(input.deviceId),
       input.clientState, digest(input.clientState), input.pkceChallenge, input.provider, input.redirectUri, input.identityGeneration],
    );
    if (!result.rows[0]) throw new Error('NATIVE_OAUTH_HANDOFF_CONFLICT');
  }

  async completeNativeHandoff(input: {
    providerState: string; status: 'succeeded' | 'failed'; errorCode?: string;
  }): Promise<({ code: string; clientState: string; provider: string; redirectUri: string; identityGeneration: number }) | null> {
    const code = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '').slice(0, 16);
    const result = input.status === 'failed'
      ? await this.options.pool.query(
          `DELETE FROM ${this.nativeHandoffsTable}
           WHERE provider_state_hash=$1 AND request_expires_at>NOW() AND code_hash IS NULL
           RETURNING client_state,callback_provider,redirect_uri,identity_generation`,
          [digest(input.providerState)],
        )
      : await this.options.pool.query(
          `UPDATE ${this.nativeHandoffsTable} SET code_hash=$2,code_expires_at=NOW()+INTERVAL '2 minutes',
             status=$3,error_code=$4,updated_at=NOW()
           WHERE provider_state_hash=$1 AND request_expires_at>NOW() AND code_hash IS NULL
           RETURNING client_state,callback_provider,redirect_uri,identity_generation`,
          [digest(input.providerState), digest(code), input.status, input.errorCode ?? null],
        );
    const row = result.rows[0];
    return row ? { code, clientState: String(row.client_state), provider: String(row.callback_provider),
      redirectUri: String(row.redirect_uri), identityGeneration: Number(row.identity_generation) } : null;
  }

  async consumeNativeHandoff(input: {
    code: string; userId: string; tenantId: string; deviceId: string; clientState: string;
    pkceChallenge: string; provider: string; redirectUri: string; identityGeneration: number;
  }): Promise<{ connectorId: string; status: 'succeeded' | 'failed'; errorCode?: string } | null> {
    const result = await this.options.pool.query(
      `DELETE FROM ${this.nativeHandoffsTable}
       WHERE code_hash=$1 AND user_id=$2 AND tenant_id=$3 AND device_hash=$4
         AND client_state_hash=$5 AND pkce_challenge=$6 AND callback_provider=$7
         AND redirect_uri=$8 AND identity_generation=$9
         AND code_expires_at>NOW() AND status IS NOT NULL
       RETURNING connector_id,status,error_code`,
      [digest(input.code), input.userId, input.tenantId, digest(input.deviceId), digest(input.clientState),
       input.pkceChallenge, input.provider, input.redirectUri, input.identityGeneration],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      connectorId: String(row.connector_id), status: row.status as 'succeeded' | 'failed',
      ...(row.error_code ? { errorCode: String(row.error_code) } : {}),
    };
  }

  async markRevocationPending(input: {
    grantId: string; tenantId: string; subjectUserId: string; purpose?: string; actorUserId?: string;
  }): Promise<OAuthGrant> {
    const result = await this.options.pool.query(
      `UPDATE ${this.grantsTable} SET status='error',revocation_stage='local_blocked',
         revocation_next_retry_at=NOW(),revocation_last_error_code=NULL,
         revocation_requested_by=COALESCE($4,revocation_requested_by,subject_user_id),
         revocation_purpose=COALESCE($5,revocation_purpose,'oauth_revoke'),
         version=version+1,updated_at=NOW()
       WHERE grant_id=$1 AND tenant_id=$2 AND subject_user_id=$3 AND status IN ('active','error') RETURNING *`,
      [input.grantId, input.tenantId, input.subjectUserId, input.actorUserId ?? null, input.purpose ?? null],
    );
    if (!result.rows[0]) throw new Error('OAUTH_GRANT_NOT_REVOCABLE');
    return grantFromRow(result.rows[0]);
  }

  async markProviderRevoking(input: { grantId: string; tenantId: string; subjectUserId: string }): Promise<OAuthGrant> {
    const result = await this.options.pool.query(
      `UPDATE ${this.grantsTable} SET revocation_stage='provider_revoking',
         revocation_attempt=revocation_attempt+1,revocation_next_retry_at=NULL,
         revocation_last_error_code=NULL,version=version+1,updated_at=NOW()
       WHERE grant_id=$1 AND tenant_id=$2 AND subject_user_id=$3
         AND status='error' AND (revocation_stage='local_blocked'
           OR (revocation_stage='provider_revoking' AND updated_at<NOW()-INTERVAL '2 minutes')) RETURNING *`,
      [input.grantId, input.tenantId, input.subjectUserId],
    );
    if (!result.rows[0]) throw new Error('OAUTH_REVOCATION_STAGE_CONFLICT');
    return grantFromRow(result.rows[0]);
  }

  async markProviderRevoked(input: { grantId: string; tenantId: string; subjectUserId: string }): Promise<OAuthGrant> {
    const result = await this.options.pool.query(
      `UPDATE ${this.grantsTable} SET revocation_stage='provider_revoked',
         revocation_next_retry_at=NOW(),revocation_last_error_code=NULL,
         version=version+1,updated_at=NOW()
       WHERE grant_id=$1 AND tenant_id=$2 AND subject_user_id=$3
         AND status='error' AND revocation_stage IN ('provider_revoking','provider_revoked') RETURNING *`,
      [input.grantId, input.tenantId, input.subjectUserId],
    );
    if (!result.rows[0]) throw new Error('OAUTH_REVOCATION_STAGE_CONFLICT');
    return grantFromRow(result.rows[0]);
  }

  async markRevocationRetry(input: {
    grantId: string; tenantId: string; subjectUserId: string; errorCode: string;
  }): Promise<OAuthGrant> {
    const result = await this.options.pool.query(
      `UPDATE ${this.grantsTable} SET revocation_stage='local_blocked',
         revocation_next_retry_at=NOW()+LEAST(INTERVAL '1 hour', INTERVAL '15 seconds' * POWER(2,LEAST(revocation_attempt,8))),
         revocation_last_error_code=$4,version=version+1,updated_at=NOW()
       WHERE grant_id=$1 AND tenant_id=$2 AND subject_user_id=$3 AND status='error' RETURNING *`,
      [input.grantId, input.tenantId, input.subjectUserId, input.errorCode.slice(0, 120)],
    );
    if (!result.rows[0]) throw new Error('OAUTH_REVOCATION_STAGE_CONFLICT');
    return grantFromRow(result.rows[0]);
  }

  async listRevocationsDue(limit = 50): Promise<OAuthGrant[]> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.grantsTable}
       WHERE status='error' AND (
         (revocation_stage IN ('local_blocked','provider_revoked') AND COALESCE(revocation_next_retry_at,NOW())<=NOW())
         OR (revocation_stage='provider_revoking' AND updated_at<NOW()-INTERVAL '2 minutes')
       )
       ORDER BY revocation_next_retry_at NULLS FIRST,updated_at LIMIT $1`, [limit],
    );
    return result.rows.map(grantFromRow);
  }

  async recordRevocation(input: {
    grantId: string; tenantId: string; subjectUserId: string; purpose?: string; actorUserId?: string;
  }): Promise<OAuthGrant> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT * FROM ${this.grantsTable} WHERE grant_id=$1 AND tenant_id=$2 AND subject_user_id=$3 FOR UPDATE`,
        [input.grantId, input.tenantId, input.subjectUserId],
      );
      if (!current.rows[0]) throw new Error('OAUTH_GRANT_NOT_FOUND');
      const grant = current.rows[0].status === 'revoked' ? current : await client.query(
        `UPDATE ${this.grantsTable} SET status='revoked',revocation_stage='local_finalized',
           revocation_next_retry_at=NULL,revocation_last_error_code=NULL,version=version+1,updated_at=NOW()
         WHERE grant_id=$1 AND tenant_id=$2 AND subject_user_id=$3 RETURNING *`,
        [input.grantId, input.tenantId, input.subjectUserId],
      );
      if (current.rows[0].status !== 'revoked') {
        await client.query(
          `INSERT INTO ${this.approvalsTable} (
             approval_id,grant_id,tenant_id,subject_user_id,action,scope_summary_json,purpose,actor_user_id
           ) VALUES ($1,$2,$3,$4,'revoked',$5::jsonb,$6,$7)`,
          [`oar-${randomUUID()}`, input.grantId, input.tenantId, input.subjectUserId,
            JSON.stringify(current.rows[0].scope_summary_json ?? []),
            input.purpose ?? String(current.rows[0].revocation_purpose ?? 'oauth_revoke'),
            input.actorUserId ?? String(current.rows[0].revocation_requested_by ?? input.subjectUserId)],
        );
      }
      await client.query('COMMIT');
      return grantFromRow(grant.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async ensureProjection(input: OAuthGrantProjectionInput): Promise<OAuthGrant> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`oauth-grant:${input.grantId}`]);
      const existing = await client.query(
        `SELECT * FROM ${this.grantsTable} WHERE grant_id=$1 AND tenant_id=$2 AND subject_user_id=$3 FOR UPDATE`,
        [input.grantId, input.tenantId, input.subjectUserId],
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return grantFromRow(existing.rows[0]);
      }
      const result = await client.query(
        `INSERT INTO ${this.grantsTable} (
           grant_id,tenant_id,subject_user_id,provider,connector_id,status,scope_summary_json,
           approved_at,expires_at,last_used_at,version
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,1) RETURNING *`,
        [input.grantId, input.tenantId, input.subjectUserId, input.provider, input.connectorId ?? null,
          input.status, JSON.stringify(input.scopeSummary), input.approvedAt, input.expiresAt ?? null, input.lastUsedAt ?? null],
      );
      const approvalId = `oar-ensure-${createHash('sha256').update(`${input.grantId}|${input.action}|${input.purpose}`).digest('hex').slice(0, 32)}`;
      await client.query(
        `INSERT INTO ${this.approvalsTable} (
           approval_id,grant_id,tenant_id,subject_user_id,action,scope_summary_json,purpose,actor_user_id
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT (approval_id) DO NOTHING`,
        [approvalId, input.grantId, input.tenantId, input.subjectUserId, input.action,
          JSON.stringify(input.scopeSummary), input.purpose, input.actorUserId],
      );
      await client.query('COMMIT');
      return grantFromRow(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordProjection(input: OAuthGrantProjectionInput): Promise<OAuthGrant> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO ${this.grantsTable} (
           grant_id,tenant_id,subject_user_id,provider,connector_id,status,scope_summary_json,
           approved_at,expires_at,last_used_at,version
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,1)
         ON CONFLICT (grant_id) DO UPDATE SET
           status=EXCLUDED.status,scope_summary_json=EXCLUDED.scope_summary_json,
           expires_at=EXCLUDED.expires_at,last_used_at=EXCLUDED.last_used_at,
           version=${this.grantsTable}.version+1,updated_at=NOW()
         WHERE ${this.grantsTable}.tenant_id=EXCLUDED.tenant_id
           AND ${this.grantsTable}.subject_user_id=EXCLUDED.subject_user_id
           AND ${this.grantsTable}.provider=EXCLUDED.provider
           AND ${this.grantsTable}.connector_id IS NOT DISTINCT FROM EXCLUDED.connector_id
         RETURNING *`,
        [
          input.grantId, input.tenantId, input.subjectUserId, input.provider, input.connectorId ?? null,
          input.status, JSON.stringify(input.scopeSummary), input.approvedAt,
          input.expiresAt ?? null, input.lastUsedAt ?? null,
        ],
      );
      if (!result.rows[0]) throw new Error('OAUTH_GRANT_IDENTITY_CONFLICT');
      await client.query(
        `INSERT INTO ${this.approvalsTable} (
           approval_id,grant_id,tenant_id,subject_user_id,action,scope_summary_json,purpose,actor_user_id
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`,
        [
          `oar-${randomUUID()}`, input.grantId, input.tenantId, input.subjectUserId,
          input.action, JSON.stringify(input.scopeSummary), input.purpose, input.actorUserId,
        ],
      );
      await client.query('COMMIT');
      return grantFromRow(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
