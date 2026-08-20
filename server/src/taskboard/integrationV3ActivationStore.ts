import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { integrationCandidateTableNames } from './integrationCandidateSchema.js';
import { TaskboardValidationError } from './types.js';

export const INTEGRATION_V3_ACTIVATION_SCHEMA_VERSION = 3;
export const INTEGRATION_V3_ACTIVATION_PROTOCOL_VERSION = 1;
/** Bump whenever the worker admission/health policy changes incompatibly. */
export const INTEGRATION_V3_ACTIVATION_POLICY_REVISION = 'integration-v3-activation-policy-2026-08-19';
export const INTEGRATION_V3_ACTIVATION_TTL_MS = 30_000;
export const INTEGRATION_V3_ACTIVATION_HEARTBEAT_MS = 10_000;

export type IntegrationV3ActivationStatus = 'healthy' | 'unhealthy' | 'inactive';
export interface IntegrationV3ActivationHealth {
  enabled: true;
  healthy: boolean;
  reason?: string;
}

type Queryable = Pick<PoolClient, 'query'>;

export class PostgresIntegrationV3ActivationStore {
  constructor(private readonly db: Queryable, private readonly table: string) {}

  async heartbeat(input: {
    processIdentity: string;
    releaseIdentity: string;
    processRole: 'all' | 'runtime-worker';
    status: IntegrationV3ActivationStatus;
    reason?: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.table}
         (process_identity,release_identity,process_role,schema_version,protocol_version,policy_revision,status,reason,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp())
       ON CONFLICT (process_identity) DO UPDATE SET
         release_identity=EXCLUDED.release_identity,process_role=EXCLUDED.process_role,
         schema_version=EXCLUDED.schema_version,protocol_version=EXCLUDED.protocol_version,
         policy_revision=EXCLUDED.policy_revision,status=EXCLUDED.status,reason=EXCLUDED.reason,
         updated_at=clock_timestamp()`,
      [input.processIdentity, input.releaseIdentity, input.processRole,
        INTEGRATION_V3_ACTIVATION_SCHEMA_VERSION, INTEGRATION_V3_ACTIVATION_PROTOCOL_VERSION,
        INTEGRATION_V3_ACTIVATION_POLICY_REVISION, input.status, input.reason ?? null],
    );
  }

  async markInactive(processIdentity: string, reason = 'stopped'): Promise<void> {
    await this.db.query(
      `UPDATE ${this.table} SET status='inactive',reason=$2,updated_at=clock_timestamp() WHERE process_identity=$1`,
      [processIdentity, reason],
    );
  }

  async compatibleHealth(ttlMs = INTEGRATION_V3_ACTIVATION_TTL_MS): Promise<IntegrationV3ActivationHealth> {
    const result = await this.db.query(
      `SELECT status,reason,updated_at,
              updated_at >= clock_timestamp()-($4::bigint * interval '1 millisecond') AS fresh,
              schema_version=$1 AND protocol_version=$2 AND policy_revision=$3 AS compatible
         FROM ${this.table}
        ORDER BY ((status='healthy') AND
                  (updated_at >= clock_timestamp()-($4::bigint * interval '1 millisecond')) AND
                  (schema_version=$1 AND protocol_version=$2 AND policy_revision=$3)) DESC,
                 updated_at DESC
        LIMIT 1`,
      [INTEGRATION_V3_ACTIVATION_SCHEMA_VERSION, INTEGRATION_V3_ACTIVATION_PROTOCOL_VERSION,
        INTEGRATION_V3_ACTIVATION_POLICY_REVISION, ttlMs],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return { enabled: true, healthy: false, reason: 'worker_heartbeat_missing' };
    if (row.compatible !== true) return { enabled: true, healthy: false, reason: 'worker_heartbeat_incompatible' };
    if (row.fresh !== true) return { enabled: true, healthy: false, reason: 'worker_heartbeat_expired' };
    if (row.status !== 'healthy') {
      return { enabled: true, healthy: false, reason: typeof row.reason === 'string' && row.reason ? row.reason : 'worker_unhealthy' };
    }
    return { enabled: true, healthy: true };
  }
}

export async function assertIntegrationV3RuntimeAvailable(
  db: Queryable,
  integrationSourcesTable: string,
): Promise<void> {
  const table = integrationCandidateTableNames(integrationSourcesTable).activationHeartbeatsTable;
  const health = await new PostgresIntegrationV3ActivationStore(db, table).compatibleHealth();
  if (!health.healthy) {
    throw new TaskboardValidationError(
      `Workflow v3 runtime is unavailable: ${health.reason ?? 'worker_unhealthy'}`,
      'TASKBOARD_INTEGRATION_V3_RUNTIME_UNAVAILABLE',
    );
  }
}

export function createIntegrationV3ActivationHeartbeat(input: {
  store: PostgresIntegrationV3ActivationStore;
  releaseIdentity: string;
  processRole: 'all' | 'runtime-worker';
  getHealth(): Promise<{ healthy: boolean; reason?: string }>;
  intervalMs?: number;
}) {
  const processIdentity = `${input.processRole}:${process.pid}:${randomUUID()}`;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let writeChain = Promise.resolve();
  let refreshChain = Promise.resolve();
  const write = (status: IntegrationV3ActivationStatus, reason?: string) => {
    writeChain = writeChain.catch(() => undefined).then(() => input.store.heartbeat({
      processIdentity,
      releaseIdentity: input.releaseIdentity,
      processRole: input.processRole,
      status,
      ...(reason ? { reason } : {}),
    }));
    return writeChain;
  };
  const refresh = () => {
    refreshChain = refreshChain.catch(() => undefined).then(async () => {
      if (stopped) return;
      let health: { healthy: boolean; reason?: string };
      try {
        health = await input.getHealth();
      } catch (error) {
        health = { healthy: false, reason: error instanceof Error ? error.message : 'heartbeat_health_failed' };
      }
      if (!stopped) await write(health.healthy ? 'healthy' : 'unhealthy', health.reason);
    });
    return refreshChain;
  };
  return {
    processIdentity,
    async start(): Promise<void> {
      await refresh();
      if (stopped) return;
      timer = setInterval(() => { void refresh().catch(() => undefined); }, input.intervalMs ?? INTEGRATION_V3_ACTIVATION_HEARTBEAT_MS);
      timer.unref();
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearInterval(timer);
      await refreshChain;
      await writeChain;
      await input.store.markInactive(processIdentity);
    },
  };
}
