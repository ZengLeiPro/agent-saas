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
    ON CONFLICT (tenant_id, session_id) DO UPDATE
    SET next_sequence = ${cursorsTable}.next_sequence + $3
    RETURNING next_sequence - $3 AS start_sequence
  `, [tenantId, sessionId, eventCount]);
  const startSequence = cursor.rows[0]?.start_sequence;
  if (startSequence === undefined) throw new Error(`Failed to allocate event sequence for ${tenantId}/${sessionId}`);
  return Number(startSequence);
}
