import type { PgPool } from './runStoreTypes.js';

export interface TaskboardSessionActivityStore {
  pool: PgPool;
  runsTable: string;
  steeringInputsTable: string;
}

export async function hasSandboxScopeActivity(
  store: TaskboardSessionActivityStore,
  input: { sandboxScopeId: string; topLevelSessionId: string; tenantId?: string },
): Promise<boolean> {
  const result = await store.pool.query<{ active: boolean }>(`
    SELECT (
      EXISTS (
        SELECT 1 FROM ${store.runsTable} run
        WHERE ($1::text = run.sandbox_scope_id OR run.metadata->>'topLevelSessionId' = $2)
          AND ($3::text IS NULL OR run.tenant_id = $3)
          AND run.status IN ('pending','running','waiting_approval','waiting_user','waiting_hand')
      )
      OR EXISTS (
        SELECT 1 FROM ${store.runsTable} background
        WHERE background.metadata->>'backgroundTask' = 'true'
          AND ($1::text = background.sandbox_scope_id OR background.metadata->>'topLevelSessionId' = $2)
          AND ($3::text IS NULL OR background.tenant_id = $3)
          AND background.status IN ('completed','failed','cancelled','orphaned')
          AND COALESCE(background.metadata->>'wakeState', 'pending') IN ('pending','delivering')
      )
    ) AS active
  `, [input.sandboxScopeId, input.topLevelSessionId, input.tenantId ?? null]);
  return result.rows[0]?.active === true;
}

export async function hasTaskboardSessionActivity(
  store: TaskboardSessionActivityStore,
  sessionIds: string[],
  tenantId?: string,
): Promise<boolean> {
  if (sessionIds.length === 0) return false;
  const result = await store.pool.query<{ active: boolean }>(`
    SELECT (
      EXISTS (
        SELECT 1
        FROM ${store.runsTable} run
        WHERE run.session_id = ANY($1::text[])
          AND ($2::text IS NULL OR run.tenant_id = $2)
          AND run.status IN ('pending','running','waiting_approval','waiting_user','waiting_hand')
          AND NOT EXISTS (
            SELECT 1
            FROM ${store.steeringInputsTable} input
            JOIN ${store.runsTable} target ON target.run_id = input.target_run_id
            WHERE input.source_run_id = run.run_id
              AND (
                (input.state = 'reserved' AND target.status NOT IN ('completed','failed','cancelled','orphaned'))
                OR (
                  input.state = 'pending'
                  AND target.status IN ('pending','running','waiting_hand')
                  AND COALESCE(target.metadata->>'steeringInputWindow', 'open') = 'open'
                )
              )
          )
      )
      OR EXISTS (
        SELECT 1
        FROM ${store.runsTable} background
        WHERE background.metadata->>'backgroundTask' = 'true'
          AND (
            background.metadata->>'parentSessionId' = ANY($1::text[])
            OR background.metadata->>'topLevelSessionId' = ANY($1::text[])
          )
          AND ($2::text IS NULL OR background.tenant_id = $2)
          AND (
            background.status IN ('pending','running','waiting_approval','waiting_user','waiting_hand')
            OR (
              background.status IN ('completed','failed','cancelled','orphaned')
              AND COALESCE(background.metadata->>'wakeState', 'pending') IN ('pending','delivering')
            )
          )
      )
    ) AS active
  `, [sessionIds, tenantId ?? null]);
  return result.rows[0]?.active === true;
}
