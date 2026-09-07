import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { HandRecord } from './handStore.js';
import { parseWorkspacePrincipal } from './workspaceIdentity.js';

/** A retired registry entry is audit history, never a request to delete its Sandbox. */
export function isSupersededHand(hand: Pick<HandRecord, 'metadata'>): boolean {
  return Object.hasOwn(hand.metadata ?? {}, 'supersededBy');
}

export type HandSupersessionResult = {
  outcome: 'superseded' | 'already_superseded' | 'no_legacy' | 'blocked';
  reason?: string;
  legacyHandId?: string;
  replacementHandId: string;
};

/** Locks both identities; normal status/registration writes use the same row locks. */
export async function supersedeLegacyHand(
  pool: pg.Pool,
  prefix: string,
  replacementHandId: string,
  tenantId: string,
  apply = true,
  expected?: {
    legacyHandId?: string;
    sessionId?: string;
    legacyUpdatedAt: string;
    replacementUpdatedAt: string;
  },
): Promise<HandSupersessionResult> {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(prefix)) throw new Error('Invalid Hand table prefix');
  const result = (
    outcome: HandSupersessionResult['outcome'],
    reason?: string,
    legacyHandId?: string,
  ): HandSupersessionResult => ({ outcome, reason, legacyHandId, replacementHandId });
  const tenantKey = createHash('sha256').update(tenantId).digest('hex').slice(0, 16);
  const qualifiedPrefix = `th_${tenantKey}:`;
  if (!replacementHandId.startsWith(qualifiedPrefix))
    return result('blocked', 'replacement_identity_mismatch');
  const legacyId = replacementHandId.slice(qualifiedPrefix.length);
  const client = await pool.connect();
  try {
    await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
    const { rows } = await client.query(
      `SELECT * FROM ${prefix}_hands WHERE tenant_id = $1 AND hand_id = ANY($2::text[]) ORDER BY hand_id${apply ? ' FOR UPDATE' : ''}`,
      [tenantId, [legacyId, replacementHandId]],
    );
    const old = rows.find((row) => row.hand_id === legacyId);
    const next = rows.find((row) => row.hand_id === replacementHandId);
    if (!old) return result('no_legacy', undefined, legacyId);
    if (
      expected &&
      ((expected.legacyHandId !== undefined && expected.legacyHandId !== legacyId) ||
        (expected.sessionId !== undefined && expected.sessionId !== old.session_id) ||
        new Date(old.updated_at).toISOString() !== expected.legacyUpdatedAt ||
        !next ||
        new Date(next.updated_at).toISOString() !== expected.replacementUpdatedAt)
    ) {
      return result('blocked', 'snapshot_changed', legacyId);
    }
    if (Object.hasOwn(old.metadata, 'supersededBy'))
      return result(
        old.metadata.supersededBy === replacementHandId ? 'already_superseded' : 'blocked',
        old.metadata.supersededBy === replacementHandId ? undefined : 'different_replacement',
        legacyId,
      );
    if (
      !next ||
      Object.hasOwn(next.metadata, 'supersededBy') ||
      next.status !== 'ready' ||
      next.metadata.provisionFailure ||
      next.metadata.provision?.lastStatus === 'error' ||
      next.metadata.reconcileRequired === true
    )
      return result('blocked', 'replacement_not_ready', legacyId);
    const provider = next.metadata.tenantRemoteHandId;
    const oldRecipe = old.metadata.recipe;
    const recipe = next.metadata.recipe;
    const principal = parseWorkspacePrincipal(next.workspace_id);
    if (
      next.type !== 'server-remote' ||
      typeof provider !== 'string' ||
      !provider ||
      principal?.kind !== 'user' ||
      principal.tenantId !== tenantId ||
      principal.userId !== next.user_id ||
      old.metadata.tenantRemoteHandId !== provider ||
      legacyId !== `${next.session_id}:${provider}` ||
      !next.session_id ||
      !next.user_id ||
      !next.endpoint ||
      ['session_id', 'workspace_id', 'user_id', 'type', 'endpoint'].some(
        (key) => old[key] !== next[key],
      ) ||
      !recipe?.sandboxScopeId ||
      !recipe.mountSubPath ||
      recipe.workspaceId !== next.workspace_id ||
      recipe.sessionId !== next.session_id ||
      ['sandboxScopeId', 'mountSubPath', 'workspaceId', 'sessionId'].some(
        (key) => oldRecipe?.[key] !== recipe[key],
      )
    ) {
      return result('blocked', 'environment_identity_mismatch', legacyId);
    }
    if (
      old.status === 'provisioning' ||
      old.metadata.reconcileRequired === true ||
      old.metadata.provisionDispatchClaim ||
      old.metadata.provisionAttemptOwner ||
      old.metadata.provisionRecoveryToken
    ) {
      return result('blocked', 'legacy_provision_in_flight', legacyId);
    }
    // Conservative: every nonterminal run previously bound to the old row prevents retirement.
    // Tool invocations can outlive their run's terminal transition, so check both authorities.
    const active = await client.query(
      `SELECT 1 FROM ${prefix}_runs WHERE tenant_id = $1 AND run_id = $2
         AND status NOT IN ('completed', 'failed', 'cancelled')
       UNION ALL
       SELECT 1 FROM ${prefix}_tool_invocations WHERE tenant_id = $1
         AND (run_id = $2 OR metadata->>'handId' = $3) AND status = 'running' LIMIT 1`,
      [tenantId, old.run_id, legacyId],
    );
    if (active.rowCount) return result('blocked', 'legacy_work_active', legacyId);
    if (apply) {
      await client.query(
        `UPDATE ${prefix}_hands SET metadata = metadata || jsonb_build_object(
          'supersededBy', $3::text, 'supersededAt', now(),
          'supersededReason', 'tenant_hand_identity_upgrade'), updated_at = now()
         WHERE tenant_id = $1 AND hand_id = $2`,
        [tenantId, legacyId, replacementHandId],
      );
      await client.query('COMMIT');
    }
    return result('superseded', apply ? undefined : 'preview_only', legacyId);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}
