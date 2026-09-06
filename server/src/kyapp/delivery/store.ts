import { randomUUID } from 'node:crypto';

import {
  PgGovernanceMigrationRunner,
  governanceTablePrefix,
  type GovernancePgPool,
} from '../../data/governance-schema/index.js';

export type KyAppOnboardStatus = 'running' | 'waiting_external' | 'completed' | 'failed';
export type KyAppOnboardStepStatus = 'pending' | 'completed' | 'waiting' | 'failed';

export interface KyAppOnboardStep {
  id: string;
  status: KyAppOnboardStepStatus;
  at?: string;
  code?: string;
  detail?: Record<string, unknown>;
}

export interface KyAppOnboardExecution {
  executionId: string;
  tenantId: string;
  systemId: string;
  installationId: string;
  requestDigest: string;
  request: Record<string, unknown>;
  status: KyAppOnboardStatus;
  currentStep: string;
  steps: KyAppOnboardStep[];
  result: Record<string, unknown>;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface KyAppDeliveryRecord {
  installationId: string;
  tenantId: string;
  systemId: string;
  deliveredAt: string | null;
  checklist: Record<string, unknown>;
  memberImport: Record<string, unknown>;
  guide: Record<string, unknown>;
  offboardingStatus: 'active' | 'planned' | 'running' | 'completed' | 'blocked';
  offboardingPlan: Record<string, unknown>;
  lowBalanceNotifiedAt: string | null;
  exhaustedNotifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

type Row = Record<string, unknown>;

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function nullableIso(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function executionFromRow(row: Row): KyAppOnboardExecution {
  return {
    executionId: String(row.execution_id),
    tenantId: String(row.tenant_id),
    systemId: String(row.system_id),
    installationId: String(row.installation_id),
    requestDigest: String(row.request_digest),
    request: row.request_json as Record<string, unknown>,
    status: row.status as KyAppOnboardStatus,
    currentStep: String(row.current_step),
    steps: row.steps_json as KyAppOnboardStep[],
    result: row.result_json as Record<string, unknown>,
    lastErrorCode: row.last_error_code === null ? null : String(row.last_error_code),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    completedAt: nullableIso(row.completed_at),
  };
}

function deliveryFromRow(row: Row): KyAppDeliveryRecord {
  return {
    installationId: String(row.installation_id),
    tenantId: String(row.tenant_id),
    systemId: String(row.system_id),
    deliveredAt: nullableIso(row.delivered_at),
    checklist: row.checklist_json as Record<string, unknown>,
    memberImport: row.member_import_json as Record<string, unknown>,
    guide: row.guide_json as Record<string, unknown>,
    offboardingStatus: row.offboarding_status as KyAppDeliveryRecord['offboardingStatus'],
    offboardingPlan: row.offboarding_plan_json as Record<string, unknown>,
    lowBalanceNotifiedAt: nullableIso(row.low_balance_notified_at),
    exhaustedNotifiedAt: nullableIso(row.exhausted_notified_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export class PgKyAppDeliveryStore {
  readonly executionsTable: string;
  readonly deliveriesTable: string;

  constructor(
    private readonly pool: GovernancePgPool,
    private readonly tablePrefix?: string,
  ) {
    const prefix = governanceTablePrefix(tablePrefix);
    this.executionsTable = `${prefix}_ky_app_onboard_executions`;
    this.deliveriesTable = `${prefix}_ky_app_delivery_records`;
  }

  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(this.pool, this.tablePrefix).run();
  }

  /** 同一安装实例的整条 onboarding 串行，防止并发 resume 重复发放或建成员。 */
  async withExecutionLock<T>(identity: string, operation: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [`ky-app:onboard:${identity}`]);
      return await operation();
    } finally {
      await client
        .query('SELECT pg_advisory_unlock(hashtext($1))', [`ky-app:onboard:${identity}`])
        .catch(() => undefined);
      client.release();
    }
  }

  async createOrResume(input: {
    tenantId: string;
    systemId: string;
    installationId: string;
    requestDigest: string;
    request: Record<string, unknown>;
  }): Promise<{ execution: KyAppOnboardExecution; created: boolean }> {
    const executionId = `onb_${randomUUID()}`;
    const result = await this.pool.query(
      `INSERT INTO ${this.executionsTable}
         (execution_id,tenant_id,system_id,installation_id,request_digest,request_json,status,current_step)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,'running','tenant_admin')
       ON CONFLICT (tenant_id,system_id,installation_id) DO NOTHING
       RETURNING *`,
      [
        executionId,
        input.tenantId,
        input.systemId,
        input.installationId,
        input.requestDigest,
        JSON.stringify(input.request),
      ],
    );
    if (result.rows[0])
      return { execution: executionFromRow(result.rows[0] as Row), created: true };
    const existing = await this.getByIdentity(input.tenantId, input.systemId, input.installationId);
    if (!existing) throw new Error('KY_APP_ONBOARD_EXECUTION_MISSING');
    if (existing.requestDigest !== input.requestDigest) {
      const error = new Error('同一交付实例的参数已变化，请使用新的 installationId');
      error.name = 'KyAppOnboardConflictError';
      throw error;
    }
    return { execution: existing, created: false };
  }

  async get(executionId: string): Promise<KyAppOnboardExecution | null> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.executionsTable} WHERE execution_id=$1`,
      [executionId],
    );
    return result.rows[0] ? executionFromRow(result.rows[0] as Row) : null;
  }

  async getByIdentity(
    tenantId: string,
    systemId: string,
    installationId: string,
  ): Promise<KyAppOnboardExecution | null> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.executionsTable} WHERE tenant_id=$1 AND system_id=$2 AND installation_id=$3`,
      [tenantId, systemId, installationId],
    );
    return result.rows[0] ? executionFromRow(result.rows[0] as Row) : null;
  }

  async update(input: {
    executionId: string;
    status: KyAppOnboardStatus;
    currentStep: string;
    steps: KyAppOnboardStep[];
    result: Record<string, unknown>;
    lastErrorCode?: string | null;
  }): Promise<KyAppOnboardExecution> {
    const updated = await this.pool.query(
      `UPDATE ${this.executionsTable}
       SET status=$2,current_step=$3,steps_json=$4::jsonb,result_json=$5::jsonb,
           last_error_code=$6,updated_at=NOW(),completed_at=CASE WHEN $2='completed' THEN NOW() ELSE NULL END
       WHERE execution_id=$1 RETURNING *`,
      [
        input.executionId,
        input.status,
        input.currentStep,
        JSON.stringify(input.steps),
        JSON.stringify(input.result),
        input.lastErrorCode ?? null,
      ],
    );
    if (!updated.rows[0]) throw new Error('KY_APP_ONBOARD_EXECUTION_MISSING');
    return executionFromRow(updated.rows[0] as Row);
  }

  async upsertDelivery(input: {
    installationId: string;
    tenantId: string;
    systemId: string;
    delivered?: boolean;
    checklist?: Record<string, unknown>;
    memberImport?: Record<string, unknown>;
    guide?: Record<string, unknown>;
  }): Promise<KyAppDeliveryRecord> {
    const result = await this.pool.query(
      `INSERT INTO ${this.deliveriesTable}
         (installation_id,tenant_id,system_id,delivered_at,checklist_json,member_import_json,guide_json)
       VALUES ($1,$2,$3,CASE WHEN $4 THEN NOW() ELSE NULL END,$5::jsonb,$6::jsonb,$7::jsonb)
       ON CONFLICT (installation_id) DO UPDATE SET
         delivered_at=CASE WHEN $4 THEN COALESCE(${this.deliveriesTable}.delivered_at,NOW()) ELSE ${this.deliveriesTable}.delivered_at END,
         checklist_json=${this.deliveriesTable}.checklist_json || EXCLUDED.checklist_json,
         member_import_json=${this.deliveriesTable}.member_import_json || EXCLUDED.member_import_json,
         guide_json=${this.deliveriesTable}.guide_json || EXCLUDED.guide_json,
         updated_at=NOW()
       RETURNING *`,
      [
        input.installationId,
        input.tenantId,
        input.systemId,
        input.delivered === true,
        JSON.stringify(input.checklist ?? {}),
        JSON.stringify(input.memberImport ?? {}),
        JSON.stringify(input.guide ?? {}),
      ],
    );
    return deliveryFromRow(result.rows[0] as Row);
  }

  async getDelivery(installationId: string): Promise<KyAppDeliveryRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.deliveriesTable} WHERE installation_id=$1`,
      [installationId],
    );
    return result.rows[0] ? deliveryFromRow(result.rows[0] as Row) : null;
  }

  async listDeliveries(): Promise<KyAppDeliveryRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.deliveriesTable} ORDER BY delivered_at DESC NULLS LAST,created_at DESC`,
    );
    return result.rows.map((row) => deliveryFromRow(row as Row));
  }

  async planOffboarding(input: {
    installationId: string;
    status: KyAppDeliveryRecord['offboardingStatus'];
    plan: Record<string, unknown>;
  }): Promise<KyAppDeliveryRecord> {
    const result = await this.pool.query(
      `UPDATE ${this.deliveriesTable}
       SET offboarding_status=$2,offboarding_plan_json=$3::jsonb,updated_at=NOW()
       WHERE installation_id=$1 RETURNING *`,
      [input.installationId, input.status, JSON.stringify(input.plan)],
    );
    if (!result.rows[0]) throw new Error('KY_APP_DELIVERY_MISSING');
    return deliveryFromRow(result.rows[0] as Row);
  }

  async setBalanceNotificationState(input: {
    tenantId: string;
    kind: 'low' | 'exhausted';
    active: boolean;
  }): Promise<boolean> {
    const column = input.kind === 'low' ? 'low_balance_notified_at' : 'exhausted_notified_at';
    if (!input.active) {
      await this.pool.query(
        `UPDATE ${this.deliveriesTable} SET ${column}=NULL,updated_at=NOW()
         WHERE tenant_id=$1 AND ${column} IS NOT NULL`,
        [input.tenantId],
      );
      return false;
    }
    const result = await this.pool.query(
      `UPDATE ${this.deliveriesTable} SET ${column}=NOW(),updated_at=NOW()
       WHERE tenant_id=$1 AND offboarding_status='active'
         AND NOT EXISTS (
           SELECT 1 FROM ${this.deliveriesTable} existing
           WHERE existing.tenant_id=$1 AND existing.${column} IS NOT NULL
         )
       RETURNING installation_id`,
      [input.tenantId],
    );
    return result.rows.length > 0;
  }
}
