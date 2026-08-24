import type pg from 'pg';

type PgPoolClient = pg.PoolClient;

export async function allocatePgEventSequences(
  client: PgPoolClient,
  cursorsTable: string,
  tenantId: string,
  sessionId: string,
  eventCount: number,
): Promise<number> {
  const cursor = await client.query<{ start_sequence: string }>(`
    INSERT INTO ${cursorsTable} (tenant_id, session_id, next_sequence)
    VALUES ($1, $2, 1 + $3)
    ON CONFLICT (session_id) DO UPDATE
    SET next_sequence = ${cursorsTable}.next_sequence + $3
    WHERE ${cursorsTable}.tenant_id = EXCLUDED.tenant_id
    RETURNING next_sequence - $3 AS start_sequence
  `, [tenantId, sessionId, eventCount]);
  if (cursor.rows[0]) return Number(cursor.rows[0].start_sequence);

  // 让数据库的全局 session_id 唯一约束给出标准 23505；这既拒绝跨租户
  // 身份碰撞，也避免继续写入一个没有本租户 cursor 的事件流。
  await client.query(`
    INSERT INTO ${cursorsTable} (tenant_id, session_id, next_sequence)
    VALUES ($1, $2, 1)
  `, [tenantId, sessionId]);
  throw new Error(`Session cursor collision was not rejected for ${sessionId}`);
}
