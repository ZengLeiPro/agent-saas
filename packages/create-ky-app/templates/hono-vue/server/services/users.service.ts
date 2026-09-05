/**
 * 本地用户的业务角色（§3.4 即时建账）。
 *
 * 唯一键 `(tid, iid, sub)`；`adminRole` 不存在这里 —— 它由目录事件的 `isTenantAdmin`
 * 与 SAT 的 `tadm` 双通道决定，落库的只有业务角色。
 */
import type { Pool } from 'pg';

export interface UserKey {
  tenantId: string;
  installationId: string;
  sub: string;
}

/** 读业务角色；没建过账返回空数组（首登无任何业务角色，§3.4）。 */
export async function getUserRoles(pool: Pool, key: UserKey): Promise<string[]> {
  const { rows } = await pool.query<{ roles: string[] }>(
    `SELECT roles FROM demo_user_role
      WHERE tenant_id = $1 AND installation_id = $2 AND sub = $3`,
    [key.tenantId, key.installationId, key.sub],
  );
  return rows[0]?.roles ?? [];
}

/** 覆盖式写入业务角色（角色权限页与 `/ky/v1/test/provision` 都走它）。 */
export async function setUserRoles(pool: Pool, key: UserKey, roles: string[]): Promise<void> {
  await pool.query(
    `INSERT INTO demo_user_role (tenant_id, installation_id, sub, roles, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (tenant_id, installation_id, sub)
     DO UPDATE SET roles = EXCLUDED.roles, updated_at = now()`,
    [key.tenantId, key.installationId, key.sub, roles],
  );
}

/** 角色权限页列表。 */
export async function listUserRoles(
  pool: Pool,
  key: Omit<UserKey, 'sub'>,
): Promise<Array<{ sub: string; roles: string[] }>> {
  const { rows } = await pool.query<{ sub: string; roles: string[] }>(
    `SELECT sub, roles FROM demo_user_role
      WHERE tenant_id = $1 AND installation_id = $2
      ORDER BY sub`,
    [key.tenantId, key.installationId],
  );
  return rows;
}
