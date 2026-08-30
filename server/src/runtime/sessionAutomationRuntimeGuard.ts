import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { ModelUsage, RunContext } from './types.js';
import { resolveAutomationBudgetReason } from './sessionAutomationBudgetProgress.js';
import { sessionAutomationTables } from './sessionAutomationStoreSchema.js';

export interface AutomationAttemptHandle {
  providerAttemptId: string;
  reservationId: string;
  sourceKey: string;
}

interface AutomationLineage {
  tenantId: string;
  sessionId: string;
  automationId: string;
  incarnationId: string;
  generation: number;
  specVersion: number;
  executionId: string;
  invokingRunId: string;
  executionRunId: string;
}

export class AutomationBudgetExceededError extends Error {
  constructor(readonly reason: string) {
    super(`automation budget exhausted: ${reason}`);
    this.name = 'AutomationBudgetExceededError';
  }
}

export class AutomationFenceRejectedError extends Error {
  constructor(readonly reason: string) {
    super(`automation fence rejected: ${reason}`);
    this.name = 'AutomationFenceRejectedError';
  }
}

/** Production fail-closed boundary around automation model/tool side effects. */
export class SessionAutomationRuntimeGuard {
  private readonly tables;

  constructor(
    private readonly pool: pg.Pool,
    private readonly tablePrefix = 'runtime',
    private readonly runsTable = `${tablePrefix}_runs`,
  ) {
    this.tables = sessionAutomationTables(tablePrefix);
  }

  private lineage(context: RunContext): AutomationLineage | undefined {
    const fence = context.automationFence;
    if (!fence) return undefined;
    if (!context.tenantId) throw new AutomationFenceRejectedError('tenant_identity_unavailable');
    if (context.runId !== fence.runId) throw new AutomationFenceRejectedError('context_run_mismatch');
    return {
      tenantId: context.tenantId,
      sessionId: context.sessionId,
      automationId: fence.automationId,
      incarnationId: fence.incarnationId,
      generation: fence.generation,
      specVersion: fence.specVersion,
      executionId: fence.executionId,
      invokingRunId: fence.runId,
      executionRunId: fence.rootRunId ?? fence.runId,
    };
  }

  private async lockFenceAndResolveBudget(
    client: pg.PoolClient,
    lineage: AutomationLineage,
  ): Promise<string | undefined> {
    const locked = await client.query<{
      status: string;
      incarnation_id: string;
      generation: string | number;
      spec_version: string | number;
      active_run_id: string | null;
    }>(
      `SELECT status,incarnation_id,generation,spec_version,active_run_id
         FROM ${this.tables.automations}
        WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3
        FOR UPDATE`,
      [lineage.tenantId, lineage.sessionId, lineage.automationId],
    );
    const automation = locked.rows[0];
    if (!automation) throw new AutomationFenceRejectedError('automation_not_found');
    if (automation.status !== 'active') throw new AutomationFenceRejectedError(`status_${automation.status}`);
    if (automation.incarnation_id !== lineage.incarnationId) throw new AutomationFenceRejectedError('incarnation_mismatch');
    if (Number(automation.generation) !== lineage.generation) throw new AutomationFenceRejectedError('generation_mismatch');
    if (Number(automation.spec_version) !== lineage.specVersion) throw new AutomationFenceRejectedError('spec_version_mismatch');
    if (automation.active_run_id !== lineage.executionRunId) throw new AutomationFenceRejectedError('active_run_mismatch');

    return resolveAutomationBudgetReason({
      client,
      tables: this.tables,
      tablePrefix: this.tablePrefix,
      runsTable: this.runsTable,
      tenantId: lineage.tenantId,
      sessionId: lineage.sessionId,
      automationId: lineage.automationId,
    });
  }

  private async expireForBudget(
    client: pg.PoolClient,
    lineage: AutomationLineage,
    reason: string,
  ): Promise<void> {
    await client.query(
      `UPDATE ${this.tables.automations}
          SET status='expired',phase='terminal',limit_hit_reason=COALESCE(limit_hit_reason,$8),
              limit_hit_at=COALESCE(limit_hit_at,now()),next_wakeup_at=NULL,updated_at=now()
        WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND incarnation_id=$4
          AND generation=$5 AND spec_version=$6 AND active_run_id=$7 AND status='active'`,
      [lineage.tenantId, lineage.sessionId, lineage.automationId, lineage.incarnationId,
        lineage.generation, lineage.specVersion, lineage.executionRunId, reason],
    );
  }

  async barrier(context: RunContext): Promise<void> {
    const lineage = this.lineage(context);
    if (!lineage) return;
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      const budgetReason = await this.lockFenceAndResolveBudget(client, lineage);
      if (budgetReason) await this.expireForBudget(client, lineage, budgetReason);
      await client.query('COMMIT');
      committed = true;
      if (budgetReason) throw new AutomationBudgetExceededError(budgetReason);
    } catch (error) {
      if (!committed) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async beforeModel(context: RunContext, operation: string): Promise<AutomationAttemptHandle | undefined> {
    const lineage = this.lineage(context);
    if (!lineage) return undefined;
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      const budgetReason = await this.lockFenceAndResolveBudget(client, lineage);
      if (budgetReason) {
        await this.expireForBudget(client, lineage, budgetReason);
        await client.query('COMMIT');
        committed = true;
        throw new AutomationBudgetExceededError(budgetReason);
      }

      const unresolved = await client.query<{ provider_attempt_id: string; state: string }>(
        `SELECT provider_attempt_id,state FROM ${this.tables.providerAttempts}
          WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND execution_id=$4 AND run_id=$5
            AND state IN ('prepared','dispatched','result_unknown','reconcile')
          FOR UPDATE`,
        [lineage.tenantId, lineage.sessionId, lineage.automationId, lineage.executionId, lineage.executionRunId],
      );
      if (unresolved.rowCount) {
        throw new Error(`automation provider attempt requires reconciliation: ${unresolved.rows[0]!.provider_attempt_id}:${unresolved.rows[0]!.state}`);
      }

      const prepared = await client.query<{ prepared_dispatch_attempt_id: string }>(
        `SELECT prepared_dispatch_attempt_id FROM ${this.tables.preparedDispatchAttempts}
          WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND incarnation_id=$4
            AND generation=$5 AND execution_id=$6 AND run_id=$7
          ORDER BY prepared_at LIMIT 1`,
        [lineage.tenantId, lineage.sessionId, lineage.automationId, lineage.incarnationId,
          lineage.generation, lineage.executionId, lineage.executionRunId],
      );
      if (!prepared.rows[0]) throw new Error('automation prepared dispatch attribution unavailable');

      const reservationId = randomUUID();
      const providerAttemptId = randomUUID();
      const sourceKey = `model:${lineage.invokingRunId}:${operation}:${randomUUID()}`;
      await client.query(
        `INSERT INTO ${this.tables.budgetReservations}
          (reservation_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,budget_kind,amount,unit,idempotency_key)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'turns',1,'turn',$9)`,
        [reservationId, lineage.tenantId, lineage.sessionId, lineage.automationId, lineage.incarnationId,
          lineage.generation, lineage.executionId, lineage.executionRunId, sourceKey],
      );
      await client.query(
        `INSERT INTO ${this.tables.providerAttempts}
          (provider_attempt_id,prepared_dispatch_attempt_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,provider,operation,idempotency_key,request_payload,state,dispatched_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'model',$10,$11,$12,'prepared',NULL)`,
        [providerAttemptId, prepared.rows[0].prepared_dispatch_attempt_id, lineage.tenantId,
          lineage.sessionId, lineage.automationId, lineage.incarnationId, lineage.generation,
          lineage.executionId, lineage.executionRunId, operation, sourceKey, JSON.stringify({ model: context.model, invokingRunId: lineage.invokingRunId })],
      );
      await client.query(
        `UPDATE ${this.tables.providerAttempts}
            SET state='dispatched',version=version+1,dispatched_at=now(),updated_at=now()
          WHERE provider_attempt_id=$1 AND state='prepared'`,
        [providerAttemptId],
      );
      await client.query('COMMIT');
      committed = true;
      return { providerAttemptId, reservationId, sourceKey };
    } catch (error) {
      if (!committed) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async finishModel(
    context: RunContext,
    handle: AutomationAttemptHandle | undefined,
    usage: ModelUsage | undefined,
    error?: unknown,
  ): Promise<void> {
    if (!handle) return;
    const lineage = this.lineage(context)!;
    const tokens = Object.values(usage ?? {}).reduce((sum, value) => sum + (typeof value === 'number' ? value : 0), 0);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (error) {
        await client.query(
          `UPDATE ${this.tables.providerAttempts} SET state='result_unknown',version=version+1,last_error=$2,updated_at=now()
            WHERE provider_attempt_id=$1 AND state='dispatched'`,
          [handle.providerAttemptId, error instanceof Error ? error.message : String(error)],
        );
        await client.query(
          `UPDATE ${this.tables.budgetReservations} SET state='result_unknown',version=version+1,updated_at=now()
            WHERE reservation_id=$1 AND state='reserved'`,
          [handle.reservationId],
        );
        await client.query(
          `UPDATE ${this.tables.automations} SET status='reconcile_required',phase='waiting',next_wakeup_at=NULL,updated_at=now()
            WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND active_run_id=$4`,
          [lineage.tenantId, lineage.sessionId, lineage.automationId, lineage.executionRunId],
        );
      } else {
        await client.query(
          `UPDATE ${this.tables.providerAttempts} SET state='completed',version=version+1,result_payload=$2,completed_at=now(),updated_at=now()
            WHERE provider_attempt_id=$1 AND state='dispatched'`,
          [handle.providerAttemptId, JSON.stringify({ usage: usage ?? null })],
        );
        await client.query(
          `UPDATE ${this.tables.budgetReservations} SET state='settled',version=version+1,updated_at=now()
            WHERE reservation_id=$1 AND state='reserved'`,
          [handle.reservationId],
        );
        await client.query(
          `INSERT INTO ${this.tables.budgetSettlements}
            (settlement_id,reservation_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,idempotency_key,amount,outcome,provider_receipt)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,'charged',$11)`,
          [randomUUID(), handle.reservationId, lineage.tenantId, lineage.sessionId, lineage.automationId,
            lineage.incarnationId, lineage.generation, lineage.executionId, lineage.executionRunId,
            `settle:${handle.sourceKey}`, JSON.stringify({ usage: usage ?? null })],
        );
        await client.query(
          `INSERT INTO ${this.tables.usage}
            (usage_id,tenant_id,session_id,automation_id,execution_id,source_key,source_kind,turns,tokens,credits)
           VALUES($1,$2,$3,$4,$5,$6,'model',1,$7,0)
           ON CONFLICT(tenant_id,automation_id,source_key) DO NOTHING`,
          [randomUUID(), lineage.tenantId, lineage.sessionId, lineage.automationId,
            lineage.executionId, handle.sourceKey, tokens],
        );
      }
      await client.query('COMMIT');
    } catch (finishError) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw finishError;
    } finally {
      client.release();
    }
  }

  async recordInteraction(
    context: RunContext,
    key: string,
    kind: string,
    state: 'active' | 'completed',
    payload: Record<string, unknown>,
  ): Promise<void> {
    const lineage = this.lineage(context);
    if (!lineage) return;
    await this.pool.query(
      `INSERT INTO ${this.tables.interactions}
        (interaction_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,interaction_key,interaction_kind,state,request_payload,response_payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT(tenant_id,interaction_key) DO UPDATE
         SET state=EXCLUDED.state,response_payload=COALESCE(EXCLUDED.response_payload,${this.tables.interactions}.response_payload),
             version=${this.tables.interactions}.version+1,updated_at=now()`,
      [randomUUID(), lineage.tenantId, lineage.sessionId, lineage.automationId, lineage.incarnationId,
        lineage.generation, lineage.executionId, lineage.executionRunId, key, kind, state, JSON.stringify(payload),
        state === 'completed' ? JSON.stringify(payload) : null],
    );
  }

  async recordBackgroundResource(
    context: Pick<RunContext, 'tenantId' | 'sessionId' | 'automationFence'>,
    resourceKey: string,
    childRunId: string,
    state: 'active' | 'released',
  ): Promise<void> {
    const lineage = this.lineage(context as RunContext);
    if (!lineage) return;
    await this.pool.query(
      `INSERT INTO ${this.tables.backgroundResources}
        (background_resource_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,resource_kind,resource_key,provider_resource_id,state,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'child_run',$9,$10,$11,$12)
       ON CONFLICT(tenant_id,resource_kind,resource_key) DO UPDATE
         SET provider_resource_id=EXCLUDED.provider_resource_id,state=EXCLUDED.state,metadata=EXCLUDED.metadata,
             version=${this.tables.backgroundResources}.version+1,updated_at=now()`,
      [randomUUID(), lineage.tenantId, lineage.sessionId, lineage.automationId, lineage.incarnationId,
        lineage.generation, lineage.executionId, lineage.executionRunId, resourceKey, childRunId, state,
        JSON.stringify({ childRunId, parentRunId: lineage.executionRunId })],
    );
  }
}
