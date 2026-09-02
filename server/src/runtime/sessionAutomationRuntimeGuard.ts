import { randomUUID } from 'node:crypto'; // durable attempt and ledger identifiers
import type pg from 'pg';
import type { ModelUsage, RunContext } from './types.js';
import { resolveAutomationBudgetReason } from './sessionAutomationBudgetProgress.js';
import { sessionAutomationTables } from './sessionAutomationStoreSchema.js';
import { PgSessionAutomationStore } from './sessionAutomationStore.js';
import { computeCostMicro, computeUsageTotalTokens, resolveModelPrice } from '../data/usage/pricing.js';
import { creditsToMicrocredits } from './sessionAutomationBudgetProgress.js';
import { costUsdMicroToCreditsMicro } from '../data/billing/pgBillingStore.js';
import { DEFAULT_CREDIT_VALUE_YUAN_MICRO, DEFAULT_FX_RATE_TO_CNY, DEFAULT_TARGET_MARGIN_BPS } from '../data/billing/types.js';
import type { SessionAutomationSpec } from '@agent/shared';
import {
  recoverInterruptedAutomationBackground,
  type InterruptedAutomationBackgroundRecovery,
} from './sessionAutomationInterruptedRecovery.js';

/** PostgreSQL NUMERIC parser for budget ledger values: scale is allowed only when fractional digits are all zero. */
export function parseWholeNumeric(value: string, field = 'amount'): bigint {
  if (!/^[+-]?\d+(?:\.0+)?$/.test(value)) throw new Error(`invalid whole NUMERIC ${field}: ${value}`);
  const integer = value.split('.', 1)[0]!;
  return BigInt(integer === '+0' || integer === '-0' ? '0' : integer);
}

export interface AutomationAttemptHandle {
  providerAttemptId: string;
  reservationIds: string[];
  sourceKey: string;
  model: string;
  purpose: 'work' | 'goal_evaluation';
  allowanceUsed?: boolean;
}

export interface AutomationModelAdmission {
  model: string;
  inputTokens: number;
  maxOutputTokens: number;
  purpose?: 'work' | 'goal_evaluation';
}

interface AutomationLineage {
  tenantId: string;
  sessionId: string;
  invokingSessionId: string;
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
    private readonly executionEnabled: () => boolean,
    private readonly tablePrefix = 'runtime',
    private readonly runsTable = `${tablePrefix}_runs`,
  ) {
    this.tables = sessionAutomationTables(tablePrefix);
  }

  /** Reads the live execution switch; exceptions fail closed. */
  private isExecutionEnabled(): boolean {
    try {
      return this.executionEnabled() === true;
    } catch {
      return false;
    }
  }

  private assertExecutionEnabled(): void {
    if (!this.isExecutionEnabled()) throw new AutomationFenceRejectedError('execution_disabled');
  }

  private lineage(context: RunContext): AutomationLineage | undefined {
    const fence = context.automationFence;
    if (!fence) return undefined;
    if (!context.tenantId) throw new AutomationFenceRejectedError('tenant_identity_unavailable');
    if (context.runId !== fence.runId) throw new AutomationFenceRejectedError('context_run_mismatch');
    return {
      tenantId: context.tenantId,
      sessionId: fence.rootSessionId ?? context.sessionId,
      invokingSessionId: context.sessionId,
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
    purpose: 'work' | 'goal_evaluation' = 'work',
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
    if (purpose === 'goal_evaluation') {
      // The terminal projector clears active_run_id before the independent evaluator runs.
      // Correlate admission to the exact terminal execution plus its claimed evaluation instead.
      const evaluation = await client.query(
        `SELECT 1 FROM ${this.tables.executions} x
          JOIN ${this.tables.evaluations} e
            ON e.tenant_id=x.tenant_id AND e.session_id=x.session_id AND e.automation_id=x.automation_id
           AND e.execution_id=x.execution_id AND e.incarnation_id=x.incarnation_id
           AND e.generation=x.generation AND e.spec_version=x.spec_version
         WHERE x.tenant_id=$1 AND x.session_id=$2 AND x.automation_id=$3
           AND x.incarnation_id=$4 AND x.generation=$5 AND x.spec_version=$6
           AND x.execution_id=$7 AND x.run_id=$8 AND x.state='terminal' AND e.state='claimed'`,
        [lineage.tenantId, lineage.sessionId, lineage.automationId, lineage.incarnationId,
          lineage.generation, lineage.specVersion, lineage.executionId, lineage.executionRunId],
      );
      if (!evaluation.rowCount) throw new AutomationFenceRejectedError('evaluation_execution_mismatch');
    } else {
      const execution = await client.query(
        `SELECT 1 FROM ${this.tables.executions}
          WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3
            AND incarnation_id=$4 AND generation=$5 AND spec_version=$6
            AND execution_id=$7 AND run_id=$8 AND state='running'`,
        [lineage.tenantId, lineage.sessionId, lineage.automationId, lineage.incarnationId,
          lineage.generation, lineage.specVersion, lineage.executionId, lineage.executionRunId],
      );
      if (!execution.rowCount) throw new AutomationFenceRejectedError('execution_mismatch');
      if (automation.active_run_id !== lineage.executionRunId) {
        throw new AutomationFenceRejectedError('active_run_mismatch');
      }
    }

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
    const store=new PgSessionAutomationStore(this.pool,this.tablePrefix,this.runsTable);
    const current=await store.getLocked(client,lineage.tenantId,lineage.sessionId,lineage.automationId);
    if(!current){await client.query(`UPDATE ${this.tables.automations} SET desired_terminal_status='expired',status='completing',phase='draining',generation=generation+1,limit_hit_reason=COALESCE(limit_hit_reason,$4),limit_hit_at=COALESCE(limit_hit_at,now()),next_wakeup_at=NULL,projection_version=projection_version+1,updated_at=now() WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND incarnation_id=$5 AND generation=$6 AND status='active'`,[lineage.tenantId,lineage.sessionId,lineage.automationId,reason,lineage.incarnationId,lineage.generation]);return;}
    if(current.incarnationId!==lineage.incarnationId||current.generation!==lineage.generation)return;
    await client.query(`UPDATE ${this.tables.automations} SET limit_hit_reason=COALESCE(limit_hit_reason,$4),limit_hit_at=COALESCE(limit_hit_at,now()) WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3`,[lineage.tenantId,lineage.sessionId,lineage.automationId,reason]);
    await store.beginTerminalDrainLocked(client,current,'expired',reason);
  }

  private async estimateCreditsMicro(
    client: pg.PoolClient,
    tenantId: string,
    model: string,
    tokens: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number },
    requireVerifiablePrice: boolean,
  ): Promise<number> {
    if (!resolveModelPrice(model)) {
      if (requireVerifiablePrice) throw new AutomationFenceRejectedError('unknown_model_price');
      return 0;
    }
    const result = await client.query<{
      credit_value_yuan_micro: string | number;
      fx_rate_to_cny: string | number;
      default_target_margin_bps: string | number;
      organization_multiplier_bps: string | number;
    }>(
      `SELECT p.credit_value_yuan_micro,p.fx_rate_to_cny,
              COALESCE(tp.default_target_margin_bps,p.default_target_margin_bps) AS default_target_margin_bps,
              COALESCE(tp.organization_multiplier_bps,10000) AS organization_multiplier_bps
         FROM ${this.tablePrefix}_billing_pricing_versions p
         LEFT JOIN ${this.tablePrefix}_billing_tenant_policies tp ON tp.tenant_id=$1
        WHERE p.status='active' ORDER BY p.effective_from DESC LIMIT 1`,
      [tenantId],
    );
    const row = result.rows[0];
    const value = costUsdMicroToCreditsMicro({
      costUsdMicro: computeCostMicro(model, tokens),
      fxRateToCny: Number(row?.fx_rate_to_cny ?? DEFAULT_FX_RATE_TO_CNY),
      creditValueYuanMicro: Number(row?.credit_value_yuan_micro ?? DEFAULT_CREDIT_VALUE_YUAN_MICRO),
      defaultTargetMarginBps: Number(row?.default_target_margin_bps ?? DEFAULT_TARGET_MARGIN_BPS),
      organizationMultiplierBps: Number(row?.organization_multiplier_bps ?? 10_000),
    });
    if (!Number.isSafeInteger(value) || value < 0) throw new AutomationFenceRejectedError('credits_unverifiable');
    return value;
  }

  async barrier(context: RunContext): Promise<void> {
    const lineage = this.lineage(context);
    if (!lineage) return;
    this.assertExecutionEnabled();
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      let budgetReason = await this.lockFenceAndResolveBudget(client, lineage);
      // run_count includes the already-admitted active run. maxRuns only gates the next dispatch.
      if (budgetReason === 'max_runs') budgetReason = undefined;
      if (budgetReason) await this.expireForBudget(client, lineage, budgetReason);
      await client.query('COMMIT');
      committed = true;
      if (budgetReason) throw new AutomationBudgetExceededError(budgetReason);
      this.assertExecutionEnabled();
    } catch (error) {
      if (!committed) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async beforeModel(
    context: RunContext,
    operation: string,
    admission: AutomationModelAdmission,
  ): Promise<AutomationAttemptHandle | undefined> {
    const lineage = this.lineage(context);
    if (!lineage) return undefined;
    this.assertExecutionEnabled();
    const estimatedInputTokens = Math.max(0, Math.ceil(admission.inputTokens));
    const maxOutputTokens = Math.max(0, Math.ceil(admission.maxOutputTokens));
    if (!admission.model || !Number.isSafeInteger(estimatedInputTokens) || !Number.isSafeInteger(maxOutputTokens)) {
      throw new AutomationFenceRejectedError('model_admission_unverifiable');
    }
    // Estimators are approximate; reserve a deterministic 10% input margin plus framing overhead.
    const inputTokens = Math.ceil(estimatedInputTokens * 1.1) + 16;
    const purpose = admission.purpose ?? 'work';
    // Keep the legacy root-run key stable for rolling retries, while child attempts must include
    // their invoking session as well as run. Child run ids are not an authority boundary and may
    // collide across independently-created hidden sessions.
    const invocationKey = lineage.invokingSessionId === lineage.sessionId
      && lineage.invokingRunId === lineage.executionRunId
      ? lineage.invokingRunId
      : `${lineage.invokingSessionId.length}:${lineage.invokingSessionId}:${lineage.invokingRunId}`;
    const sourceKey = `model:${lineage.executionId}:${invocationKey}:${operation}`;
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      let budgetReason = await this.lockFenceAndResolveBudget(client, lineage, purpose);
      if (budgetReason === 'max_runs') budgetReason = undefined;

      const budgetRow = await client.query<{spec: SessionAutomationSpec;run_count:string|number}>(
        `SELECT s.spec,a.run_count FROM ${this.tables.automations} a
          JOIN ${this.tables.specs} s
            ON s.tenant_id=a.tenant_id AND s.session_id=a.session_id AND s.automation_id=a.automation_id
           AND s.spec_version=a.spec_version
         WHERE a.tenant_id=$1 AND a.session_id=$2 AND a.automation_id=$3
           AND a.incarnation_id=$4 AND a.generation=$5 AND a.spec_version=$6`,
        [lineage.tenantId,lineage.sessionId,lineage.automationId,lineage.incarnationId,lineage.generation,lineage.specVersion],
      );
      const budget = budgetRow.rows[0]?.spec.budget ?? {};
      if (Number(budgetRow.rows[0]?.run_count ?? 0) > (budget.maxRuns ?? Number.MAX_SAFE_INTEGER)) budgetReason='max_runs';

      const existing = await client.query<{provider_attempt_id:string;state:string;request_payload:Record<string,unknown>}>(
        `SELECT provider_attempt_id,state,request_payload FROM ${this.tables.providerAttempts}
          WHERE tenant_id=$1 AND provider='model' AND idempotency_key=$2 FOR UPDATE`,
        [lineage.tenantId,sourceKey],
      );
      let replayReservations: Array<{reservation_id:string;purpose:'work'|'goal_evaluation'}> | undefined;
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (row.request_payload.model !== admission.model || row.request_payload.purpose !== purpose
          || Number(row.request_payload.inputTokens) !== inputTokens || Number(row.request_payload.maxOutputTokens) !== maxOutputTokens) {
          throw new AutomationFenceRejectedError('idempotency_payload_mismatch');
        }
        if (!['dispatched','cancelled'].includes(row.state)) throw new Error(`automation provider attempt is not replayable: ${row.provider_attempt_id}:${row.state}`);
        const reservations = await client.query<{reservation_id:string;purpose:'work'|'goal_evaluation'}>(
          `SELECT reservation_id,purpose FROM ${this.tables.budgetReservations} WHERE tenant_id=$1 AND idempotency_key LIKE $2 ORDER BY budget_kind`,
          [lineage.tenantId,`${sourceKey}:%`],
        );
        if (row.state === 'dispatched') {
          const handle: AutomationAttemptHandle = { providerAttemptId: row.provider_attempt_id, reservationIds: reservations.rows.map(item => item.reservation_id), sourceKey, model: admission.model, purpose, allowanceUsed: reservations.rows[0]?.purpose === 'goal_evaluation' };
          await client.query('COMMIT'); committed=true;
          await this.rejectDisabledAdmission(client,lineage,handle);
          return handle;
        }
        replayReservations=reservations.rows;
      }

      const prospectiveTokens = inputTokens + maxOutputTokens;
      const prospectiveCreditsMicro = await this.estimateCreditsMicro(client,lineage.tenantId,admission.model,{
        inputTokens,outputTokens:maxOutputTokens,cacheReadTokens:0,cacheCreationTokens:0,
      }, budget.maxCredits !== undefined);
      const totals = await client.query<{turns:string;tokens:string;credits:string}>(
        `SELECT COALESCE(SUM(turns),0)::text turns,COALESCE(SUM(tokens),0)::text tokens,COALESCE(SUM(credits),0)::text credits
           FROM ${this.tables.usage}
          WHERE tenant_id=$1 AND automation_id=$2 AND source_kind<>'goal_evaluation'`,
        [lineage.tenantId,lineage.automationId],
      );
      const reserved = await client.query<{turns:string;tokens:string;credits:string}>(
        `SELECT COALESCE(SUM(amount) FILTER(WHERE budget_kind='turns'),0)::text turns,COALESCE(SUM(amount) FILTER(WHERE budget_kind='tokens'),0)::text tokens,COALESCE(SUM(amount) FILTER(WHERE budget_kind='credits'),0)::text credits FROM ${this.tables.budgetReservations} WHERE tenant_id=$1 AND automation_id=$2 AND purpose='work' AND state IN ('reserved','result_unknown','reconcile')`,
        [lineage.tenantId,lineage.automationId],
      );
      // automation_run rows contain terminal-minus-provider deltas, so all non-evaluation usage is additive.
      const used=totals.rows[0]!, held=reserved.rows[0]!;
      const maxCreditsMicro = budget.maxCredits === undefined ? undefined : creditsToMicrocredits(budget.maxCredits);
      if (budget.maxCredits !== undefined && maxCreditsMicro === undefined) budgetReason='credits_unverifiable';
      if (!budgetReason && budget.maxTurns !== undefined && parseWholeNumeric(used.turns,'used.turns')+parseWholeNumeric(held.turns,'held.turns')+1n > BigInt(budget.maxTurns)) budgetReason='max_turns';
      else if (!budgetReason && budget.maxTokens !== undefined && parseWholeNumeric(used.tokens,'used.tokens')+parseWholeNumeric(held.tokens,'held.tokens')+BigInt(prospectiveTokens) > BigInt(budget.maxTokens)) budgetReason='max_tokens';
      else if (!budgetReason && maxCreditsMicro !== undefined && parseWholeNumeric(used.credits,'used.credits')+parseWholeNumeric(held.credits,'held.credits')+BigInt(prospectiveCreditsMicro) > maxCreditsMicro) budgetReason='max_credits';

      let usingAllowance = false;
      if (purpose === 'goal_evaluation' && (!budgetReason || budgetReason.startsWith('max_'))) {
        if (maxOutputTokens !== 500) throw new AutomationFenceRejectedError('completion_allowance_output_mismatch');
        const allowance = await client.query(
          `UPDATE ${this.tables.completionAllowances} SET remaining_attempts=remaining_attempts-1,updated_at=now()
            WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND remaining_attempts>0 AND max_output_tokens=$4
            RETURNING remaining_attempts`,
          [lineage.tenantId,lineage.sessionId,lineage.automationId,maxOutputTokens],
        );
        if (allowance.rows[0]) { usingAllowance=true; budgetReason=undefined; }
        else budgetReason='completion_allowance_exhausted';
      }
      if (budgetReason) {
        await this.expireForBudget(client,lineage,budgetReason);
        await client.query('COMMIT'); committed=true;
        throw new AutomationBudgetExceededError(budgetReason);
      }

      if (replayReservations) {
        await client.query(`UPDATE ${this.tables.budgetReservations} SET state='reserved',version=version+1,updated_at=now() WHERE reservation_id=ANY($1::uuid[]) AND state='released'`,[replayReservations.map(item=>item.reservation_id)]);
        await client.query(`UPDATE ${this.tables.providerAttempts} SET state='dispatched',version=version+1,last_error=NULL,dispatched_at=now(),updated_at=now() WHERE tenant_id=$1 AND provider='model' AND idempotency_key=$2 AND state='cancelled'`,[lineage.tenantId,sourceKey]);
        const handle: AutomationAttemptHandle = {providerAttemptId:existing.rows[0]!.provider_attempt_id,reservationIds:replayReservations.map(item=>item.reservation_id),sourceKey,model:admission.model,purpose,allowanceUsed:usingAllowance};
        await client.query('COMMIT'); committed=true;
        await this.rejectDisabledAdmission(client,lineage,handle);
        return handle;
      }

      const unresolved = await client.query<{provider_attempt_id:string;state:string}>(
        `SELECT provider_attempt_id,state FROM ${this.tables.providerAttempts} WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND execution_id=$4 AND run_id=$5 AND state IN ('prepared','dispatched','result_unknown','reconcile') FOR UPDATE`,
        [lineage.tenantId,lineage.sessionId,lineage.automationId,lineage.executionId,lineage.executionRunId],
      );
      if (unresolved.rowCount) throw new Error(`automation provider attempt requires reconciliation: ${unresolved.rows[0]!.provider_attempt_id}:${unresolved.rows[0]!.state}`);
      const prepared = await client.query<{prepared_dispatch_attempt_id:string}>(
        `SELECT prepared_dispatch_attempt_id FROM ${this.tables.preparedDispatchAttempts} WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND incarnation_id=$4 AND generation=$5 AND execution_id=$6 AND run_id=$7 ORDER BY prepared_at LIMIT 1`,
        [lineage.tenantId,lineage.sessionId,lineage.automationId,lineage.incarnationId,lineage.generation,lineage.executionId,lineage.executionRunId],
      );
      if (!prepared.rows[0]) throw new Error('automation prepared dispatch attribution unavailable');
      const providerAttemptId=randomUUID();
      const reservations:[string,string,number,string][]=[
        [randomUUID(),'runs',0,'run'],[randomUUID(),'turns',1,'turn'],[randomUUID(),'tokens',prospectiveTokens,'token'],[randomUUID(),'credits',prospectiveCreditsMicro,'microcredit'],
      ];
      for (const [id,kind,amount,unit] of reservations) await client.query(
        `INSERT INTO ${this.tables.budgetReservations}(reservation_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,budget_kind,purpose,amount,unit,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [id,lineage.tenantId,lineage.sessionId,lineage.automationId,lineage.incarnationId,lineage.generation,lineage.executionId,lineage.executionRunId,kind,purpose,amount,unit,`${sourceKey}:${kind}`],
      );
      await client.query(
        `INSERT INTO ${this.tables.providerAttempts}(provider_attempt_id,prepared_dispatch_attempt_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,invoking_session_id,invoking_run_id,provider,operation,idempotency_key,request_payload,state,dispatched_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'model',$12,$13,$14,'dispatched',now())`,
        [providerAttemptId,prepared.rows[0].prepared_dispatch_attempt_id,lineage.tenantId,lineage.sessionId,lineage.automationId,lineage.incarnationId,lineage.generation,lineage.executionId,lineage.executionRunId,lineage.invokingSessionId,lineage.invokingRunId,operation,sourceKey,JSON.stringify({model:admission.model,inputTokens,maxOutputTokens,purpose,incarnationId:lineage.incarnationId,generation:lineage.generation,specVersion:lineage.specVersion,executionId:lineage.executionId,rootSessionId:lineage.sessionId,rootRunId:lineage.executionRunId,invokingSessionId:lineage.invokingSessionId,invokingRunId:lineage.invokingRunId})],
      );
      const handle: AutomationAttemptHandle = {providerAttemptId,reservationIds:reservations.map(x=>x[0]),sourceKey,model:admission.model,purpose,allowanceUsed:usingAllowance};
      await client.query('COMMIT'); committed=true;
      await this.rejectDisabledAdmission(client,lineage,handle);
      return handle;
    } catch(error) { if(!committed) await client.query('ROLLBACK').catch(()=>undefined); throw error; }
    finally { client.release(); }
  }

  private async rejectDisabledAdmission(
    client: pg.PoolClient,
    lineage: AutomationLineage,
    handle: AutomationAttemptHandle,
  ): Promise<void> {
    if (this.isExecutionEnabled()) return;
    await client.query('BEGIN');
    try {
      await this.releaseModelLocked(client, lineage, handle, 'session_automation_execution_disabled');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
    throw new AutomationFenceRejectedError('execution_disabled');
  }

  private async releaseModelLocked(
    client: pg.PoolClient,
    lineage: AutomationLineage,
    handle: AutomationAttemptHandle,
    reason: string,
  ): Promise<boolean> {
    const released = await client.query(
      `UPDATE ${this.tables.providerAttempts} SET state='cancelled',version=version+1,last_error=$2,updated_at=now() WHERE provider_attempt_id=$1 AND state='dispatched'`,
      [handle.providerAttemptId, reason],
    );
    if (released.rowCount !== 1) return false;
    await client.query(`UPDATE ${this.tables.budgetReservations} SET state='released',version=version+1,updated_at=now() WHERE reservation_id=ANY($1::uuid[]) AND state='reserved'`,[handle.reservationIds]);
    if(handle.allowanceUsed) await client.query(`UPDATE ${this.tables.completionAllowances} SET remaining_attempts=LEAST(2,remaining_attempts+1),updated_at=now() WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3`,[lineage.tenantId,lineage.sessionId,lineage.automationId]);
    return true;
  }

  /** Re-check immediately before a real provider attempt; release only a never-sent admission. */
  async beforeModelTransport(
    context: RunContext,
    handle: AutomationAttemptHandle | undefined,
    releaseIfRejected: boolean,
  ): Promise<void> {
    try {
      await this.barrier(context);
    } catch (error) {
      if (releaseIfRejected && handle && error instanceof AutomationFenceRejectedError) {
        await this.releaseModel(context, handle, `pre_transport_${error.reason}`);
      }
      throw error;
    }
  }

  /** Release a prepared evaluator attempt if platform authorization fails before transport. */
  async releaseModel(context: RunContext, handle: AutomationAttemptHandle | undefined, reason: string): Promise<void> {
    if (!handle) return;
    const lineage=this.lineage(context)!;
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.releaseModelLocked(client, lineage, handle, reason);
      await client.query('COMMIT');
    }catch(e){await client.query('ROLLBACK').catch(()=>undefined);throw e}finally{client.release()}
  }

  /** Persist a retryable billing close on the existing typed lifecycle worker. */
  async ensureBillingClosure(context: RunContext, billingRunId: string): Promise<void> {
    const lineage=this.lineage(context);
    if(!lineage)return;
    const client=await this.pool.connect();
    try{
      await client.query('BEGIN');
      const fence=await client.query(
        `SELECT 1 FROM ${this.tables.automations}
          WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3
            AND incarnation_id=$4 AND generation=$5 FOR UPDATE`,
        [lineage.tenantId,lineage.sessionId,lineage.automationId,lineage.incarnationId,lineage.generation],
      );
      if(!fence.rowCount)throw new AutomationFenceRejectedError('stale_billing_closure_fence');
      await client.query(
        `INSERT INTO ${this.tables.lifecycleWork}
          (work_id,tenant_id,session_id,automation_id,incarnation_id,generation,object_incarnation_id,object_generation,object_type,object_id,action,last_error)
         VALUES($1,$2,$3,$4,$5,$6,$5,$6,'run',$7,'reconcile','billing_finalize_failed')
         ON CONFLICT(tenant_id,automation_id,incarnation_id,generation,object_type,object_id,action)
         DO UPDATE SET state=CASE WHEN ${this.tables.lifecycleWork}.state='completed' THEN 'completed' ELSE 'pending' END,
           next_attempt_at=now(),lease_token=NULL,lease_expires_at=NULL,last_error='billing_finalize_failed',updated_at=now()`,
        [randomUUID(),lineage.tenantId,lineage.sessionId,lineage.automationId,lineage.incarnationId,lineage.generation,billingRunId],
      );
      await client.query('COMMIT');
    }catch(e){await client.query('ROLLBACK').catch(()=>undefined);throw e}finally{client.release()}
  }

  async finishModel(
    context: RunContext,
    handle: AutomationAttemptHandle | undefined,
    usage: ModelUsage | undefined,
    error?: unknown,
    resultPayload?: Record<string, unknown>,
  ): Promise<void> {
    if (!handle) return;
    const lineage=this.lineage(context)!;
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Global mutation order: automation -> lifecycle work -> provider/reservation.
      const authority=await client.query(
        `SELECT 1 FROM ${this.tables.automations}
          WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 FOR UPDATE`,
        [lineage.tenantId,lineage.sessionId,lineage.automationId],
      );
      if(!authority.rowCount)throw new AutomationFenceRejectedError('automation_authority_missing');
      let unknown=!!error || !usage;
      let amounts: {runs:number;turns:number;tokens:number;credits:number} | undefined;
      if (usage) {
        const tokens={inputTokens:usage.inputTokens??0,outputTokens:usage.outputTokens??0,cacheReadTokens:usage.cacheReadInputTokens??0,cacheCreationTokens:usage.cacheCreationInputTokens??0};
        amounts={
          runs:0,turns:1,
          tokens:computeUsageTotalTokens(handle.model,tokens),
          credits:await this.estimateCreditsMicro(client,lineage.tenantId,handle.model,tokens,false),
        };
        const heldResult=await client.query<{budget_kind:string;amount:string}>(
          `SELECT budget_kind,amount::text FROM ${this.tables.budgetReservations} WHERE reservation_id=ANY($1::uuid[]) FOR UPDATE`,
          [handle.reservationIds],
        );
        const held=new Map(heldResult.rows.map(row=>[row.budget_kind,parseWholeNumeric(row.amount,`reservation.${row.budget_kind}`)]));
        if(Object.entries(amounts).some(([kind,amount])=>BigInt(amount)> (held.get(kind)??-1n))){
          unknown=true;
          error=new Error('actual_usage_exceeded_reservation');
        }
      }
      if(unknown){
        const markedUnknown = await client.query(`UPDATE ${this.tables.providerAttempts} SET state='result_unknown',version=version+1,last_error=$2,updated_at=now() WHERE provider_attempt_id=$1 AND state='dispatched'`,[handle.providerAttemptId,error instanceof Error?error.message:error?String(error):'usage_unavailable']);
        if (markedUnknown.rowCount === 1) {
          await client.query(`UPDATE ${this.tables.budgetReservations} SET state='result_unknown',version=version+1,updated_at=now() WHERE reservation_id=ANY($1::uuid[]) AND state='reserved'`,[handle.reservationIds]);
          // The terminal projector clears active_run_id before goal evaluation. Fence the
          // authoritative automation incarnation instead of relying on the cleared run slot.
          await client.query(`UPDATE ${this.tables.automations} SET status='reconcile_required',phase='waiting',next_wakeup_at=NULL,projection_version=projection_version+1,updated_at=now() WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND incarnation_id=$4 AND generation=$5 AND spec_version=$6 AND status='active'`,[lineage.tenantId,lineage.sessionId,lineage.automationId,lineage.incarnationId,lineage.generation,lineage.specVersion]);
        }
      }else{
        await client.query(`UPDATE ${this.tables.providerAttempts} SET state='completed',version=version+1,result_payload=$2,completed_at=now(),updated_at=now() WHERE provider_attempt_id=$1 AND tenant_id=$3 AND session_id=$4 AND automation_id=$5 AND incarnation_id=$6 AND generation=$7 AND execution_id=$8 AND run_id=$9 AND state='dispatched'`,[handle.providerAttemptId,JSON.stringify({usage,...resultPayload}),lineage.tenantId,lineage.sessionId,lineage.automationId,lineage.incarnationId,lineage.generation,lineage.executionId,lineage.executionRunId]);
        await client.query(`UPDATE ${this.tables.budgetReservations} SET state='settled',version=version+1,updated_at=now() WHERE reservation_id=ANY($1::uuid[]) AND state='reserved'`,[handle.reservationIds]);
        for(const [kind,amount] of Object.entries(amounts!)) await client.query(
          `INSERT INTO ${this.tables.budgetSettlements}(settlement_id,reservation_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,idempotency_key,amount,outcome,provider_receipt) SELECT $1,reservation_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,$2,$3,'charged',$4 FROM ${this.tables.budgetReservations} WHERE reservation_id=ANY($5::uuid[]) AND budget_kind=$6 ON CONFLICT(tenant_id,idempotency_key) DO NOTHING`,
          [randomUUID(),`settle:${handle.sourceKey}:${kind}`,amount,JSON.stringify({usage}),handle.reservationIds,kind],
        );
        await client.query(`INSERT INTO ${this.tables.usage}(usage_id,tenant_id,session_id,automation_id,execution_id,source_key,source_kind,turns,tokens,credits) VALUES($1,$2,$3,$4,$5,$6,$7,1,$8,$9) ON CONFLICT(tenant_id,automation_id,source_key) DO NOTHING`,[randomUUID(),lineage.tenantId,lineage.sessionId,lineage.automationId,lineage.executionId,handle.sourceKey,handle.purpose==='goal_evaluation'?'goal_evaluation':'model',amounts!.tokens,amounts!.credits]);
        await client.query(`UPDATE ${this.tables.lifecycleWork} SET state='completed',lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE tenant_id=$1 AND automation_id=$2 AND state IN ('pending','claimed','result_unknown') AND ((object_type='provider_attempt' AND object_id=$3) OR (object_type='budget_reservation' AND object_id=ANY($4::text[])))`,[lineage.tenantId,lineage.automationId,handle.providerAttemptId,handle.reservationIds]);
      }
      // A stale-generation attempt can still close authority owned by the current drain.
      await new PgSessionAutomationStore(this.pool,this.tablePrefix,this.runsTable).tryFinalizeLocked(client,lineage.tenantId,lineage.sessionId,lineage.automationId);
      await client.query('COMMIT');
    }catch(e){await client.query('ROLLBACK').catch(()=>undefined);throw e}finally{client.release()}
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
    this.assertExecutionEnabled();
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      let budgetReason = await this.lockFenceAndResolveBudget(client, lineage);
      // The current run was already admitted; maxRuns only fences the next dispatch.
      if (budgetReason === 'max_runs') budgetReason = undefined;
      if (budgetReason) {
        await this.expireForBudget(client, lineage, budgetReason);
      } else {
        // The process-local switch cannot be part of the SQL predicate. Re-read it after
        // acquiring the automation row lock and immediately before the durable UPSERT.
        this.assertExecutionEnabled();
        const interaction = await client.query<{ interaction_id: string }>(
          `INSERT INTO ${this.tables.interactions}
            (interaction_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,interaction_key,interaction_kind,state,request_payload,response_payload)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT(tenant_id,interaction_key) DO UPDATE
             SET state=EXCLUDED.state,response_payload=COALESCE(EXCLUDED.response_payload,${this.tables.interactions}.response_payload),
                 version=${this.tables.interactions}.version+1,updated_at=now()
           WHERE ${this.tables.interactions}.session_id=EXCLUDED.session_id
             AND ${this.tables.interactions}.automation_id=EXCLUDED.automation_id
             AND ${this.tables.interactions}.incarnation_id=EXCLUDED.incarnation_id
             AND ${this.tables.interactions}.generation=EXCLUDED.generation
             AND ${this.tables.interactions}.execution_id=EXCLUDED.execution_id
             AND ${this.tables.interactions}.run_id=EXCLUDED.run_id
             AND ${this.tables.interactions}.interaction_kind=EXCLUDED.interaction_kind
           RETURNING interaction_id`,
          [randomUUID(), lineage.tenantId, lineage.sessionId, lineage.automationId, lineage.incarnationId,
            lineage.generation, lineage.executionId, lineage.executionRunId, key, kind, state, JSON.stringify(payload),
            state === 'completed' ? JSON.stringify(payload) : null],
        );
        if (interaction.rowCount !== 1) throw new AutomationFenceRejectedError('interaction_lineage_mismatch');
        if (state === 'completed') {
          await client.query(
            `UPDATE ${this.tables.lifecycleWork}
                SET state='completed',lease_token=NULL,lease_expires_at=NULL,updated_at=now()
              WHERE tenant_id=$1 AND automation_id=$2 AND object_type='interaction'
                AND object_id=$3::text AND state IN ('pending','claimed','result_unknown')`,
            [lineage.tenantId, lineage.automationId, interaction.rows[0]!.interaction_id],
          );
          await new PgSessionAutomationStore(this.pool,this.tablePrefix,this.runsTable)
            .tryFinalizeLocked(client,lineage.tenantId,lineage.sessionId,lineage.automationId);
        }
      }
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

  async recoverInterruptedBackgroundChild(
    context: Pick<RunContext, 'tenantId' | 'sessionId' | 'runId' | 'automationFence'>,
    resourceKey: string,
    identity: { childSessionId: string; childRunId: string },
  ): Promise<InterruptedAutomationBackgroundRecovery> {
    const lineage = this.lineage(context as RunContext);
    if (!lineage) return 'reconcile_required';
    return recoverInterruptedAutomationBackground(
      this.pool, this.runsTable, this.tablePrefix, this.tables, lineage, resourceKey, identity,
    );
  }

  private async lockBackgroundAuthority(client: pg.PoolClient, lineage: AutomationLineage, requireInvokingRun: boolean): Promise<void> {
    await this.lockFenceAndResolveBudget(client, lineage);
    const root = await client.query(
      `SELECT 1 FROM ${this.runsTable}
        WHERE tenant_id=$1 AND session_id=$2 AND run_id=$3 AND status='running'
        FOR UPDATE`,
      [lineage.tenantId, lineage.sessionId, lineage.executionRunId],
    );
    if (root.rowCount !== 1) throw new AutomationFenceRejectedError('active_root_run_mismatch');
    if (requireInvokingRun) {
      const invoking = await client.query(
        `SELECT 1 FROM ${this.runsTable}
          WHERE tenant_id=$1 AND session_id=$2 AND run_id=$3 AND status='running'
          FOR UPDATE`,
        [lineage.tenantId, lineage.invokingSessionId, lineage.invokingRunId],
      );
      if (invoking.rowCount !== 1) throw new AutomationFenceRejectedError('invoking_run_not_running');
    }
    this.assertExecutionEnabled();
  }

  private async upsertPreparedBackgroundResource(client: pg.PoolClient, lineage: AutomationLineage, resourceKey: string,
    identity: { childSessionId: string; childRunId: string }): Promise<void> {
    const metadata = JSON.stringify({
      ...identity,
      invokingSessionId: lineage.invokingSessionId,
      invokingRunId: lineage.invokingRunId,
      rootSessionId: lineage.sessionId,
      rootRunId: lineage.executionRunId,
    });
    const result = await client.query(
      `INSERT INTO ${this.tables.backgroundResources}
        (background_resource_id,tenant_id,session_id,automation_id,incarnation_id,generation,execution_id,run_id,resource_kind,resource_key,provider_resource_id,state,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'child_run',$9,$10,'prepared',$11)
       ON CONFLICT(tenant_id,resource_kind,resource_key) DO UPDATE
         SET version=${this.tables.backgroundResources}.version+1,updated_at=now()
         WHERE ${this.tables.backgroundResources}.provider_resource_id=EXCLUDED.provider_resource_id
           AND ${this.tables.backgroundResources}.metadata->>'childSessionId'=EXCLUDED.metadata->>'childSessionId'
           AND ${this.tables.backgroundResources}.automation_id=EXCLUDED.automation_id
           AND ${this.tables.backgroundResources}.incarnation_id=EXCLUDED.incarnation_id
           AND ${this.tables.backgroundResources}.generation=EXCLUDED.generation
           AND ${this.tables.backgroundResources}.execution_id=EXCLUDED.execution_id
           AND ${this.tables.backgroundResources}.run_id=EXCLUDED.run_id
           AND ${this.tables.backgroundResources}.state='prepared'
       RETURNING state`,
      [randomUUID(), lineage.tenantId, lineage.sessionId, lineage.automationId, lineage.incarnationId,
        lineage.generation, lineage.executionId, lineage.executionRunId, resourceKey, identity.childRunId, metadata],
    );
    if (result.rowCount !== 1 || result.rows[0]?.state !== 'prepared') {
      throw new AutomationFenceRejectedError('background_resource_identity_mismatch');
    }
  }

  /** Atomically publishes intent and makes the already-staged task scheduler-visible. */
  async activateBackgroundResourceIntent(
    context: Pick<RunContext, 'tenantId' | 'sessionId' | 'runId' | 'automationFence'>,
    resourceKey: string,
    identity: { childSessionId: string; childRunId: string },
  ): Promise<void> {
    const lineage = this.lineage(context as RunContext);
    if (!lineage) return;
    const client = await this.pool.connect();let committed=false;
    try {
      await client.query('BEGIN');
      await this.lockBackgroundAuthority(client,lineage,false);
      await this.upsertPreparedBackgroundResource(client,lineage,resourceKey,identity);
      const activated=await client.query(`UPDATE ${this.runsTable} SET metadata=metadata||$4::jsonb,status_reason='background_task_started',updated_at=now() WHERE tenant_id=$1 AND session_id=$2 AND run_id=$3 AND status='pending' AND COALESCE((metadata->>'backgroundTaskReady')::boolean,false)=false RETURNING run_id`,[lineage.tenantId,lineage.invokingSessionId,lineage.invokingRunId,JSON.stringify({backgroundTaskReady:true,backgroundStartedAt:new Date().toISOString()})]);
      if(activated.rowCount!==1)throw new AutomationFenceRejectedError('background_task_activation_lost');
      await client.query('COMMIT');committed=true;
    } catch(error){if(!committed)await client.query('ROLLBACK').catch(()=>undefined);throw error;} finally{client.release();}
  }

  async recordBackgroundResource(
    context: Pick<RunContext, 'tenantId' | 'sessionId' | 'runId' | 'automationFence'>,
    resourceKey: string,
    identity: { childSessionId: string; childRunId: string },
    state: 'prepared' | 'active',
  ): Promise<void> {
    const lineage = this.lineage(context as RunContext);
    if (!lineage) return;
    if (state === 'active') {
      // Final durable boundary before tenant /provision: validate and lock the
      // whole authority chain, then consume prepared intent in this transaction.
      const client = await this.pool.connect();
      let committed = false;
      try {
        await client.query('BEGIN');
        const authority = await client.query(
          `SELECT 1
             FROM ${this.tables.automations} a
             JOIN ${this.tables.executions} e
               ON e.tenant_id=a.tenant_id AND e.session_id=a.session_id
              AND e.automation_id=a.automation_id AND e.incarnation_id=a.incarnation_id
              AND e.generation=a.generation
             JOIN ${this.runsTable} root_run ON root_run.tenant_id=a.tenant_id AND root_run.run_id=$8
             JOIN ${this.runsTable} parent_run ON parent_run.tenant_id=a.tenant_id AND parent_run.run_id=$9
             JOIN ${this.runsTable} child_run ON child_run.tenant_id=a.tenant_id AND child_run.run_id=$10
            WHERE a.tenant_id=$1 AND a.session_id=$2 AND a.automation_id=$3
              AND a.incarnation_id=$4 AND a.generation=$5 AND a.spec_version=$6
              AND a.status='active' AND a.active_run_id=$8
              AND e.execution_id=$7 AND e.run_id=$8 AND e.state='running'
              AND root_run.session_id=$2 AND root_run.status='running'
              AND parent_run.session_id=$11 AND parent_run.status='running'
              AND child_run.session_id=$12 AND child_run.status='running'
            FOR UPDATE OF a,e,root_run,parent_run,child_run`,
          [lineage.tenantId, lineage.sessionId, lineage.automationId, lineage.incarnationId,
            lineage.generation, lineage.specVersion, lineage.executionId, lineage.executionRunId,
            lineage.invokingRunId, identity.childRunId, lineage.invokingSessionId, identity.childSessionId],
        );
        if (authority.rowCount !== 1) throw new AutomationFenceRejectedError('background_dispatch_authority_lost');
        // The execution switch is process-local and cannot participate in the SQL
        // predicate. Re-read the same authoritative source after BEGIN + locks and
        // immediately before consuming prepared intent; a false result rolls back.
        this.assertExecutionEnabled();
        const activated = await client.query(
          `UPDATE ${this.tables.backgroundResources}
              SET state='active',version=version+1,updated_at=now()
            WHERE tenant_id=$1 AND automation_id=$2 AND incarnation_id=$3 AND generation=$4
              AND execution_id=$5 AND run_id=$6 AND resource_kind='child_run' AND resource_key=$7
              AND provider_resource_id=$8 AND metadata->>'childSessionId'=$9
              AND state IN ('launching','active') RETURNING state`,
          [lineage.tenantId, lineage.automationId, lineage.incarnationId, lineage.generation,
            lineage.executionId, lineage.executionRunId, resourceKey, identity.childRunId, identity.childSessionId],
        );
        if (activated.rowCount !== 1) throw new AutomationFenceRejectedError('background_resource_identity_mismatch');
        await client.query('COMMIT');
        committed = true;
      } catch (error) {
        if (!committed) await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    } else {
      // The producer is the sole creator of prepared intent. A worker must never
      // resurrect stale authority with an UPSERT after clear/replace has swept it.
      await this.assertBackgroundResourcePrepared(context, resourceKey, identity);
    }
  }

  async claimBackgroundResourceLaunch(
    context: Pick<RunContext, 'tenantId' | 'sessionId' | 'runId' | 'automationFence'>,
    resourceKey: string,
    identity: { childSessionId: string; childRunId: string },
  ): Promise<void> {
    this.assertExecutionEnabled();
    const lineage = this.lineage(context as RunContext);
    if (!lineage) return;
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      await this.lockBackgroundAuthority(client, lineage, true);
      const claimed = await client.query(
        `UPDATE ${this.tables.backgroundResources}
            SET state='launching',metadata=metadata||$13::jsonb,version=version+1,updated_at=now()
          WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3
            AND incarnation_id=$4 AND generation=$5 AND execution_id=$6 AND run_id=$7
            AND resource_kind='child_run' AND resource_key=$8 AND provider_resource_id=$9
            AND metadata->>'childSessionId'=$10 AND metadata->>'childRunId'=$9
            AND metadata->>'invokingSessionId'=$11 AND metadata->>'invokingRunId'=$12
            AND state IN ('prepared','launching') RETURNING background_resource_id`,
        [lineage.tenantId, lineage.sessionId, lineage.automationId, lineage.incarnationId,
          lineage.generation, lineage.executionId, lineage.executionRunId, resourceKey,
          identity.childRunId, identity.childSessionId, lineage.invokingSessionId, lineage.invokingRunId,
          JSON.stringify({ launchClaimedAt: new Date().toISOString() })],
      );
      if (claimed.rowCount !== 1) throw new AutomationFenceRejectedError('background_launch_authority_lost');
      await client.query('COMMIT');
      committed = true;
    } catch (error) {
      if (!committed) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async resolveBackgroundResourceFromChild(
    context: Pick<RunContext, 'tenantId' | 'sessionId' | 'runId' | 'automationFence'>,
    resourceKey: string,
    identity: { childSessionId: string; childRunId: string },
    workerStopped = false,
  ): Promise<'released' | 'result_unknown'> {
    const lineage = this.lineage(context as RunContext);
    if (!lineage) return 'released';
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      await client.query(`SELECT 1 FROM ${this.tables.automations} WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 FOR UPDATE`,[lineage.tenantId,lineage.sessionId,lineage.automationId]);
      const resource = await client.query<{ background_resource_id: string; state: string }>(
        `SELECT background_resource_id,state FROM ${this.tables.backgroundResources}
          WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3
            AND incarnation_id=$4 AND generation=$5 AND execution_id=$6 AND run_id=$7
            AND resource_kind='child_run' AND resource_key=$8 AND provider_resource_id=$9
            AND metadata->>'childSessionId'=$10 AND metadata->>'childRunId'=$9
            AND metadata->>'invokingSessionId'=$11 AND metadata->>'invokingRunId'=$12
            AND metadata->>'rootSessionId'=$2 AND metadata->>'rootRunId'=$7
          FOR UPDATE`,
        [lineage.tenantId, lineage.sessionId, lineage.automationId, lineage.incarnationId,
          lineage.generation, lineage.executionId, lineage.executionRunId, resourceKey,
          identity.childRunId, identity.childSessionId, lineage.invokingSessionId, lineage.invokingRunId],
      );
      const locked = resource.rows[0];
      if (!locked) throw new AutomationFenceRejectedError('background_resource_identity_mismatch');
      if (locked.state === 'released') {
        await client.query('COMMIT');
        committed = true;
        return 'released';
      }
      const child = await client.query<{ status: string }>(
        `SELECT status FROM ${this.runsTable}
          WHERE tenant_id=$1 AND session_id=$2 AND run_id=$3 FOR UPDATE`,
        [lineage.tenantId, identity.childSessionId, identity.childRunId],
      );
      const terminal = child.rowCount === 1
        && ['completed', 'failed', 'cancelled', 'orphaned'].includes(child.rows[0]!.status);
      // Only the worker that has fully stopped may prove that a missing child Run had
      // no side effect. Lifecycle polling must not infer this while a launching worker
      // can still cross the next boundary.
      const safeMissingChild = workerStopped && child.rowCount === 0;
      const resolution = terminal || safeMissingChild ? 'released' : 'result_unknown';
      await client.query(
        `UPDATE ${this.tables.backgroundResources}
            SET state=$2,version=version+1,updated_at=now()
          WHERE background_resource_id=$1 AND state<>'released'`,
        [locked.background_resource_id, resolution],
      );
      if (terminal || safeMissingChild) {
        await client.query(
          `UPDATE ${this.tables.lifecycleWork}
              SET state='completed',lease_token=NULL,lease_expires_at=NULL,updated_at=now()
            WHERE tenant_id=$1 AND automation_id=$2 AND object_type='background_resource'
              AND object_id=$3 AND state IN ('pending','claimed','waiting','result_unknown')`,
          [lineage.tenantId, lineage.automationId, locked.background_resource_id],
        );
        const store = new PgSessionAutomationStore(this.pool, this.tablePrefix, this.runsTable);
        await store.tryFinalizeLocked(client, lineage.tenantId, lineage.sessionId, lineage.automationId);
      } else {
        await client.query(
          `UPDATE ${this.tables.lifecycleWork}
              SET state='result_unknown',lease_token=NULL,lease_expires_at=NULL,
                  last_error='background_child_terminal_state_unknown',updated_at=now()
            WHERE tenant_id=$1 AND automation_id=$2 AND object_type='background_resource'
              AND object_id=$3 AND state IN ('pending','claimed','waiting')`,
          [lineage.tenantId, lineage.automationId, locked.background_resource_id],
        );
        await client.query(
          `UPDATE ${this.tables.automations}
              SET status='reconcile_required',phase='waiting',next_wakeup_at=NULL,
                  projection_version=projection_version+1,updated_at=now()
            WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3
              AND incarnation_id=$4 AND generation=$5 AND spec_version=$6
              AND status='active'`,
          [lineage.tenantId, lineage.sessionId, lineage.automationId, lineage.incarnationId,
            lineage.generation, lineage.specVersion],
        );
      }
      await client.query('COMMIT');
      committed = true;
      return resolution;
    } catch (error) {
      if (!committed) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async assertBackgroundResourcePrepared(
    context: Pick<RunContext, 'tenantId' | 'sessionId' | 'runId' | 'automationFence'>,
    resourceKey: string,
    identity: { childSessionId: string; childRunId: string },
  ): Promise<void> {
    this.assertExecutionEnabled();
    const lineage = this.lineage(context as RunContext);
    if (!lineage) return;
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      await this.lockBackgroundAuthority(client, lineage, true);
      const result = await client.query(
        `SELECT 1 FROM ${this.tables.backgroundResources}
          WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3
            AND incarnation_id=$4 AND generation=$5 AND execution_id=$6 AND run_id=$7
            AND resource_kind='child_run' AND resource_key=$8 AND provider_resource_id=$9
            AND metadata->>'childSessionId'=$10 AND metadata->>'childRunId'=$9
            AND metadata->>'invokingSessionId'=$11 AND metadata->>'invokingRunId'=$12
            AND metadata->>'rootSessionId'=$2 AND metadata->>'rootRunId'=$7
            AND state IN ('prepared','launching','active')
          FOR UPDATE`,
        [lineage.tenantId, lineage.sessionId, lineage.automationId, lineage.incarnationId,
          lineage.generation, lineage.executionId, lineage.executionRunId, resourceKey,
          identity.childRunId, identity.childSessionId, lineage.invokingSessionId, lineage.invokingRunId],
      );
      if (result.rowCount !== 1) throw new AutomationFenceRejectedError('background_resource_not_prepared');
      await client.query('COMMIT');
      committed = true;
    } catch (error) {
      if (!committed) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
