/**
 * WP2a 安装实例的跨租户只读查询与运行状态小改动。
 *
 * 单独成文件而不是塞进 `systems/store.ts` / `runtimeStore.ts`：那两个文件是发布迁移审核
 * （`config/release-migration-reviews.json`）已登记摘要的启动期建表模块，改动它们会让
 * 全部基线的审核条目失配。本文件不建表、不含 DDL，只在既有表上做 SELECT 与一处计数复位。
 */
import type { GovernancePgPool } from '../../data/governance-schema/index.js';
import type { KyAppInstallation } from '../systems/types.js';

/** 后台循环需要的最小实例视图（不含 stateVersion 之外的写字段）。 */
export interface KyAppInstallationBrief {
  installationId: string;
  tenantId: string;
  systemId: string;
  baseUrl: string;
  origin: string;
  status: KyAppInstallation['status'];
  stateVersion: number;
  registeredDigest: string | null;
}

function rowToBrief(row: Record<string, unknown>): KyAppInstallationBrief {
  return {
    installationId: String(row.installation_id),
    tenantId: String(row.tenant_id),
    systemId: String(row.system_id),
    baseUrl: String(row.base_url),
    origin: String(row.origin),
    status: String(row.status) as KyAppInstallation['status'],
    stateVersion: Number(row.state_version),
    registeredDigest: row.registered_digest === null ? null : String(row.registered_digest),
  };
}

/** 列出全部 `enabled` 安装实例（事件投递、健康探测、JWKS 切换证据都按它遍历）。 */
export async function listEnabledKyAppInstallations(
  pool: GovernancePgPool,
  table: string,
): Promise<KyAppInstallationBrief[]> {
  const result = await pool.query(
    `SELECT installation_id, tenant_id, system_id, base_url, origin, status,
            state_version, registered_digest
     FROM ${table} WHERE status = 'enabled' ORDER BY installation_id`,
  );
  return result.rows.map((row) => rowToBrief(row as Record<string, unknown>));
}

/** 列出所有未删除实例（平台管理端列表与凭据到期巡检用）。 */
export async function listLiveKyAppInstallations(
  pool: GovernancePgPool,
  table: string,
): Promise<KyAppInstallationBrief[]> {
  const result = await pool.query(
    `SELECT installation_id, tenant_id, system_id, base_url, origin, status,
            state_version, registered_digest
     FROM ${table} WHERE status <> 'deleted' ORDER BY installation_id`,
  );
  return result.rows.map((row) => rowToBrief(row as Record<string, unknown>));
}

/**
 * 告警恢复后清掉 `alerted_at`，让下一轮连续失败可以再次告警。
 * 与 `runtimeStore.markAlerted` 是同一张表上的对称操作。
 */
export async function clearKyAppInstallationAlert(
  pool: GovernancePgPool,
  table: string,
  installationId: string,
): Promise<void> {
  await pool.query(
    `UPDATE ${table} SET alerted_at = NULL, updated_at = NOW() WHERE installation_id = $1`,
    [installationId],
  );
}

/**
 * 供后台循环使用的实例目录。把 pool 与表名收在一处，
 * 避免 dispatcher / prober 各自持有连接池细节。
 */
export class KyAppInstallationDirectory {
  constructor(
    private readonly pool: GovernancePgPool,
    private readonly table: string,
  ) {}

  listEnabled(): Promise<KyAppInstallationBrief[]> {
    return listEnabledKyAppInstallations(this.pool, this.table);
  }

  listLive(): Promise<KyAppInstallationBrief[]> {
    return listLiveKyAppInstallations(this.pool, this.table);
  }
}
