import type { PoolClient } from 'pg';

export async function findRunForUpdate(
  client: PoolClient,
  runsTable: string,
  runId: string,
): Promise<Record<string, unknown> | null> {
  const result = await client.query<{ row_json: Record<string, unknown> }>(
    `SELECT row_to_json(existing.*) AS row_json
       FROM ${runsTable} existing WHERE run_id=$1 FOR UPDATE`,
    [runId],
  );
  return result.rows[0]?.row_json ?? null;
}

export async function findRun(
  client: PoolClient,
  runsTable: string,
  runId: string,
): Promise<Record<string, unknown> | null> {
  const result = await client.query<{ row_json: Record<string, unknown> }>(
    `SELECT row_to_json(existing.*) AS row_json
       FROM ${runsTable} existing WHERE run_id=$1`,
    [runId],
  );
  return result.rows[0]?.row_json ?? null;
}
