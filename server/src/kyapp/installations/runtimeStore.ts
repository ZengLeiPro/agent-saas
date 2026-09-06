/**
 * WP2a 安装实例运行状态（规范 §4.6、§8.5）。
 *
 * live 每 60 s、ready 每 5 分钟；ready 结果里带 `manifestDigest` 与 `jwksKids`。
 * 连续失败计数由本表维护，达到阈值由 Phase B 的探测器触发钉钉告警。
 */
import {
  PgGovernanceMigrationRunner,
  governanceTablePrefix,
  type GovernancePgPool,
} from '../../data/governance-schema/index.js';

export type KyAppLiveStatus = 'unknown' | 'ok' | 'maintenance' | 'failed';
export type KyAppReadyStatus = 'unknown' | 'ok' | 'failed';

export interface KyAppInstallationRuntimeRecord {
  installationId: string;
  liveStatus: KyAppLiveStatus;
  liveCheckedAt: string | null;
  readyStatus: KyAppReadyStatus;
  readyCheckedAt: string | null;
  manifestDigest: string | null;
  contractVersion: number | null;
  appVersion: string | null;
  directoryCheckpoint: string | null;
  directoryAgeSeconds: number | null;
  jwksKids: string[];
  consecutiveFailures: number;
  lastError: string | null;
  alertedAt: string | null;
  updatedAt: string;
}

type Row = Record<string, unknown>;

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function rowToRecord(row: Row): KyAppInstallationRuntimeRecord {
  return {
    installationId: String(row.installation_id),
    liveStatus: String(row.live_status) as KyAppLiveStatus,
    liveCheckedAt: isoOrNull(row.live_checked_at),
    readyStatus: String(row.ready_status) as KyAppReadyStatus,
    readyCheckedAt: isoOrNull(row.ready_checked_at),
    manifestDigest: row.manifest_digest === null ? null : String(row.manifest_digest),
    contractVersion: numberOrNull(row.contract_version),
    appVersion: row.app_version === null ? null : String(row.app_version),
    directoryCheckpoint:
      row.directory_checkpoint === null ? null : String(row.directory_checkpoint),
    directoryAgeSeconds: numberOrNull(row.directory_age_seconds),
    jwksKids: Array.isArray(row.jwks_kids) ? (row.jwks_kids as string[]) : [],
    consecutiveFailures: Number(row.consecutive_failures),
    lastError: row.last_error === null ? null : String(row.last_error),
    alertedAt: isoOrNull(row.alerted_at),
    updatedAt: iso(row.updated_at),
  };
}

export interface PgKyAppInstallationRuntimeStoreOptions {
  pool: GovernancePgPool;
  tablePrefix?: string;
}

export class PgKyAppInstallationRuntimeStore {
  readonly table: string;
  private readonly tablePrefix?: string;

  constructor(private readonly options: PgKyAppInstallationRuntimeStoreOptions) {
    this.tablePrefix = options.tablePrefix;
    this.table = `${governanceTablePrefix(options.tablePrefix)}_ky_app_installation_runtime`;
  }

  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(this.options.pool, this.tablePrefix).run();
  }

  async get(installationId: string): Promise<KyAppInstallationRuntimeRecord | null> {
    const result = await this.options.pool.query(
      `SELECT * FROM ${this.table} WHERE installation_id = $1`,
      [installationId],
    );
    return result.rows[0] ? rowToRecord(result.rows[0] as Row) : null;
  }

  /** 记录一次 live 探测；成功清零连续失败计数，失败递增。 */
  async recordLive(input: {
    installationId: string;
    status: Exclude<KyAppLiveStatus, 'unknown'>;
    error?: string;
  }): Promise<KyAppInstallationRuntimeRecord> {
    const failed = input.status === 'failed';
    const result = await this.options.pool.query(
      `INSERT INTO ${this.table}
         (installation_id,live_status,live_checked_at,consecutive_failures,last_error,updated_at)
       VALUES ($1,$2,NOW(),$3,$4,NOW())
       ON CONFLICT (installation_id) DO UPDATE SET
         live_status = EXCLUDED.live_status,
         live_checked_at = NOW(),
         consecutive_failures = CASE
           WHEN $3 = 0 THEN 0 ELSE ${this.table}.consecutive_failures + 1 END,
         last_error = EXCLUDED.last_error,
         updated_at = NOW()
       RETURNING *`,
      [input.installationId, input.status, failed ? 1 : 0, input.error?.slice(0, 500) ?? null],
    );
    return rowToRecord(result.rows[0] as Row);
  }

  /** 记录一次 ready 探测（含 digest 比对所需字段）。 */
  async recordReady(input: {
    installationId: string;
    status: Exclude<KyAppReadyStatus, 'unknown'>;
    manifestDigest?: string;
    contractVersion?: number;
    appVersion?: string;
    directoryCheckpoint?: string;
    directoryAgeSeconds?: number;
    jwksKids?: readonly string[];
    error?: string;
  }): Promise<KyAppInstallationRuntimeRecord> {
    const result = await this.options.pool.query(
      `INSERT INTO ${this.table}
         (installation_id,ready_status,ready_checked_at,manifest_digest,contract_version,app_version,
          directory_checkpoint,directory_age_seconds,jwks_kids,last_error,updated_at)
       VALUES ($1,$2,NOW(),$3,$4,$5,$6,$7,$8::jsonb,$9,NOW())
       ON CONFLICT (installation_id) DO UPDATE SET
         ready_status = EXCLUDED.ready_status,
         ready_checked_at = NOW(),
         manifest_digest = COALESCE(EXCLUDED.manifest_digest, ${this.table}.manifest_digest),
         contract_version = COALESCE(EXCLUDED.contract_version, ${this.table}.contract_version),
         app_version = COALESCE(EXCLUDED.app_version, ${this.table}.app_version),
         directory_checkpoint = COALESCE(EXCLUDED.directory_checkpoint, ${this.table}.directory_checkpoint),
         directory_age_seconds = COALESCE(EXCLUDED.directory_age_seconds, ${this.table}.directory_age_seconds),
         jwks_kids = EXCLUDED.jwks_kids,
         last_error = EXCLUDED.last_error,
         updated_at = NOW()
       RETURNING *`,
      [
        input.installationId,
        input.status,
        input.manifestDigest ?? null,
        input.contractVersion ?? null,
        input.appVersion ?? null,
        input.directoryCheckpoint ?? null,
        input.directoryAgeSeconds ?? null,
        JSON.stringify([...(input.jwksKids ?? [])]),
        input.error?.slice(0, 500) ?? null,
      ],
    );
    return rowToRecord(result.rows[0] as Row);
  }

  /** 记录已发出告警的时刻，避免重复打扰。 */
  async markAlerted(installationId: string): Promise<void> {
    await this.options.pool.query(
      `UPDATE ${this.table} SET alerted_at=NOW(), updated_at=NOW() WHERE installation_id=$1`,
      [installationId],
    );
  }
}
