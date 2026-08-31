import { randomUUID } from 'node:crypto';
import { resolveAutomationBudgetReason } from './sessionAutomationBudgetProgress.js';
export { reduceNoProgress } from './sessionAutomationBudgetProgress.js';
import type pg from 'pg';
import type { BillingService } from '../data/billing/service.js';
import type { ModelProviderOptions } from '../types/index.js';
import type { ModelAdapter, ModelUsage, RunContext } from './types.js';
import { SessionAutomationRuntimeGuard, type AutomationAttemptHandle } from './sessionAutomationRuntimeGuard.js';
import type { PgSessionAutomationStore } from './sessionAutomationStore.js';
import { estimateContextTokens } from './contextBreakdown.js';

/** Evidence consumed by the monotonically versioned automation projection. */
export interface GoalEvidence {
  summary: string;
  evidenceRefs: string[];
  hardGates: {
    runTerminal: boolean;
    noPendingInteraction: boolean;
    noActiveResources: boolean;
    budgetValid: boolean;
  };
}
export type GoalDecision = 'met' | 'continue' | 'blocked' | 'unverifiable';
export interface GoalEvaluatorPort {
  evaluate(input: {
    tenantId: string;
    sessionId: string;
    ownerUserId: string;
    automationId: string;
    executionId: string;
    incarnationId: string;
    generation: number;
    specVersion: number;
    condition: string;
    evidence: GoalEvidence;
    evaluatorRunId?: string;
    executionRunId?: string;
    onAttemptPrepared?: (providerAttemptId: string) => Promise<void>;
  }): Promise<{ decision: GoalDecision; reason: string; confidence: number; usage?: ModelUsage }>;
}

export function passesGoalHardGates(evidence: GoalEvidence): boolean {
  return evidence.hardGates.runTerminal
    && evidence.hardGates.noPendingInteraction
    && evidence.hardGates.noActiveResources
    && evidence.hardGates.budgetValid
    && evidence.evidenceRefs.length > 0;
}

function parsePersistedGoalDecision(payload: unknown): { decision: GoalDecision; reason: string; confidence: number } | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const evaluation = (payload as Record<string, unknown>).evaluation;
  if (!evaluation || typeof evaluation !== 'object') return undefined;
  const result = evaluation as Record<string, unknown>;
  if (!['met', 'continue', 'blocked', 'unverifiable'].includes(String(result.decision))
    || typeof result.reason !== 'string' || typeof result.confidence !== 'number'
    || !Number.isFinite(result.confidence)) return undefined;
  return {
    decision: result.decision as GoalDecision,
    reason: result.reason,
    confidence: Math.max(0, Math.min(1, result.confidence)),
  };
}

export class GoalEvaluationResultUnknownError extends Error {
  constructor(message: string, readonly providerAttemptId: string) {
    super(message);
    this.name = 'GoalEvaluationResultUnknownError';
  }
}

/** Independent utility-model evaluator; it is not the primary automation agent. */
export class ModelGoalEvaluator implements GoalEvaluatorPort {
  constructor(private readonly options: {
    resolveModel: (tenantId: string) => { model: string; connection?: { apiKey?: string; baseUrl?: string }; providerOptions?: ModelProviderOptions } | null;
    createAdapter: (connection: { apiKey?: string; baseUrl?: string } | undefined, options?: ModelProviderOptions) => ModelAdapter;
    billing: () => BillingService | undefined;
    resolveIdentity: (userId: string) => { username: string } | undefined;
    runtimeGuard?: SessionAutomationRuntimeGuard;
  }) {}

  async evaluate(input: Parameters<GoalEvaluatorPort['evaluate']>[0]): Promise<{ decision: GoalDecision; reason: string; confidence: number }> {
    const resolved = this.options.resolveModel(input.tenantId);
    if (!resolved) throw new Error('result_unknown:model_unavailable');
    const identity = this.options.resolveIdentity(input.ownerUserId);
    if (!identity) throw new Error('result_unknown:owner_unavailable');
    const billing = await this.options.billing()?.beginUtilityModelRun({
      tenantId: input.tenantId,
      userId: input.ownerUserId,
      username: identity.username,
      sessionId: input.sessionId,
      channel: 'automation_evaluator',
      attribution: {
        rootAutomationId: input.automationId,
        automationExecutionId: input.executionId,
        automationGeneration: input.generation,
      },
    });
    const adapter = this.options.createAdapter(resolved.connection, resolved.providerOptions);
    const evaluatorRunId = input.evaluatorRunId ?? `automation-evaluator-${randomUUID()}`;
    const context: RunContext = {
      runId: evaluatorRunId,
      sessionId: input.sessionId,
      model: resolved.model,
      cwd: '.',
      tenantId: input.tenantId,
      channelContext: { channel: 'web', resumeSessionId: input.sessionId },
      automationFence: {
        automationId: input.automationId,
        incarnationId: input.incarnationId,
        generation: input.generation,
        specVersion: input.specVersion,
        executionId: input.executionId,
        runId: evaluatorRunId,
        ...(input.executionRunId ? { rootRunId: input.executionRunId } : {}),
      },
      ...(billing ? { authorizeModelTurn: billing.beforeModelCall } : {}),
    };
    let text = '';
    let completed = false;
    let usage: ModelUsage | undefined;
    let attempt: AutomationAttemptHandle | undefined;
    let transportStarted = false;
    try {
      const evaluationMessages = [
        { role: 'system' as const, content: 'You are an independent completion verifier. Never trust a claimant assertion without evidence. Return only JSON: {"decision":"met|continue|blocked|unverifiable","reason":"...","confidence":0..1}.' },
        { role: 'user' as const, content: JSON.stringify({ completionCondition: input.condition, evidence: input.evidence }) },
      ];
      attempt = await this.options.runtimeGuard?.beforeModel(context, `goal-evaluation:${input.executionId}`, {
        model: resolved.model, inputTokens: estimateContextTokens(evaluationMessages), maxOutputTokens: 500, purpose: 'goal_evaluation',
      });
      if (attempt) await input.onAttemptPrepared?.(attempt.providerAttemptId);
      // Evaluator owns this transport boundary: authorize before any provider bytes are sent.
      await context.authorizeModelTurn?.();
      transportStarted = true;
      const transportContext = { ...context, authorizeModelTurn: undefined };
      for await (const event of adapter.stream({
        model: resolved.model,
        messages: evaluationMessages,
        tools: [],
        toolChoice: 'none',
        maxOutputTokens: 500,
        signal: new AbortController().signal,
      }, transportContext)) {
        if (event.type === 'text_delta') text += event.content;
        if (event.type === 'completed') {
          completed = true;
          text = event.content || text;
          usage = event.usage;
          if (event.usage && billing) await billing.recordUsage(resolved.model, event.usage);
          if (event.terminalStatus && event.terminalStatus !== 'completed') throw new Error(`result_unknown:${event.terminalStatus}`);
        }
      }
      if (!completed) throw new Error('result_unknown:no_terminal_result');
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (!['met', 'continue', 'blocked', 'unverifiable'].includes(String(parsed.decision))
        || typeof parsed.reason !== 'string' || typeof parsed.confidence !== 'number'
        || !Number.isFinite(parsed.confidence)) {
        throw new Error('result_unknown:invalid_evaluator_json');
      }
      await this.options.runtimeGuard?.finishModel(context, attempt, usage, undefined, {
        evaluation: {
          decision: parsed.decision as GoalDecision,
          reason: parsed.reason,
          confidence: Math.max(0, Math.min(1, parsed.confidence)),
        },
      });
      return {
        decision: parsed.decision as GoalDecision,
        reason: parsed.reason,
        confidence: Math.max(0, Math.min(1, parsed.confidence)),
        ...(usage ? { usage } : {}),
      };
    } catch (error) {
      if (attempt) {
        if (transportStarted) {
          await this.options.runtimeGuard?.finishModel(context, attempt, usage, error);
          throw new GoalEvaluationResultUnknownError(
            error instanceof Error ? error.message : String(error),
            attempt.providerAttemptId,
          );
        }
        await this.options.runtimeGuard?.releaseModel(
          context,
          attempt,
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    } finally {
      await billing?.finalize();
    }
  }
}

export class SessionAutomationEvaluator {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly eventsTable: string;

  constructor(
    readonly store: PgSessionAutomationStore,
    readonly evaluator: GoalEvaluatorPort,
    readonly executionEnabled: () => boolean = () => true,
  ) {
    this.eventsTable = `${store.tablePrefix}_events`;
  }

  private async resolveHardGates(client: pg.Pool | pg.PoolClient, input: {
    tenantId: string;
    sessionId: string;
    automationId: string;
    executionId: string;
    runId: string;
  }): Promise<GoalEvidence['hardGates']> {
    const execution = await client.query(
      `SELECT state FROM ${this.store.tables.executions}
        WHERE execution_id=$1 AND tenant_id=$2 AND session_id=$3 AND run_id=$4`,
      [input.executionId, input.tenantId, input.sessionId, input.runId],
    );
    const active = await client.query(
      `SELECT COUNT(*)::int AS count FROM ${this.store.runsTable}
        WHERE tenant_id=$1 AND session_id=$2 AND run_id<>$3 AND status IN ('pending','running')`,
      [input.tenantId, input.sessionId, input.runId],
    );
    const pendingInteraction = await client.query(
      `SELECT EXISTS(
         SELECT 1 FROM ${this.eventsTable} requested
          WHERE requested.tenant_id=$1 AND requested.session_id=$2 AND requested.event_type='interaction_requested'
            AND NOT EXISTS(
              SELECT 1 FROM ${this.eventsTable} resolved
               WHERE resolved.tenant_id=requested.tenant_id AND resolved.session_id=requested.session_id
                 AND resolved.event_type='interaction_resolved'
                 AND resolved.event_json->>'interactionId'=requested.event_json->>'interactionId'
            )
       ) AS pending`,
      [input.tenantId, input.sessionId],
    );
    const durableInteractions = await client.query(
      `SELECT EXISTS(
         SELECT 1 FROM ${this.store.tables.interactions}
          WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3
            AND state IN ('prepared','active','result_unknown','reconcile')
       ) AS pending`,
      [input.tenantId, input.sessionId, input.automationId],
    );
    const durableResources = await client.query(
      `SELECT EXISTS(
         SELECT 1 FROM ${this.store.tables.backgroundResources}
          WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3
            AND state IN ('prepared','active','release_pending','result_unknown','reconcile')
       ) AS active`,
      [input.tenantId, input.sessionId, input.automationId],
    );
    const automation = await client.query(
      `SELECT limit_hit_reason FROM ${this.store.tables.automations}
        WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3`,
      [input.tenantId, input.sessionId, input.automationId],
    );
    const budgetReason = await resolveAutomationBudgetReason({
      client,
      tables: this.store.tables,
      tablePrefix: this.store.tablePrefix,
      runsTable: this.store.runsTable,
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      automationId: input.automationId,
    });
    return {
      runTerminal: execution.rows[0]?.state === 'terminal',
      noPendingInteraction: pendingInteraction.rows[0]?.pending !== true
        && durableInteractions.rows[0]?.pending !== true,
      noActiveResources: Number(active.rows[0]?.count ?? 0) === 0
        && durableResources.rows[0]?.active !== true,
      budgetValid: !automation.rows[0]?.limit_hit_reason && (budgetReason === undefined || budgetReason.startsWith('max_')),
    };
  }

  async nominate(input: {
    tenantId: string;
    sessionId: string;
    automationId: string;
    executionId: string;
    runId: string;
    incarnationId: string;
    generation: number;
    specVersion: number;
    summary: string;
    evidenceRefs: string[];
  }): Promise<{ queued: boolean; reason?: string }> {
    if (input.evidenceRefs.length === 0) return { queued: false, reason: 'hard_gate' };
    return this.store.tx(async client => {
      const snapshot = await this.store.getLocked(client, input.tenantId, input.sessionId, input.automationId);
      if (!snapshot || snapshot.spec.kind !== 'goal' || snapshot.status !== 'active'
        || snapshot.activeRunId !== input.runId || snapshot.incarnationId !== input.incarnationId
        || snapshot.generation !== input.generation || snapshot.specVersion !== input.specVersion) {
        return { queued: false, reason: 'stale_fence' };
      }
      const execution = await client.query(
        `SELECT 1 FROM ${this.store.tables.executions}
          WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND execution_id=$4
            AND run_id=$5 AND incarnation_id=$6 AND generation=$7 AND spec_version=$8
            AND state<>'terminal'`,
        [input.tenantId, input.sessionId, input.automationId, input.executionId, input.runId,
          input.incarnationId, input.generation, input.specVersion],
      );
      if (!execution.rowCount) return { queued: false, reason: 'stale_fence' };
      await client.query(
        `INSERT INTO ${this.store.tables.goalCompletionCandidates}
          (candidate_id,tenant_id,session_id,automation_id,execution_id,incarnation_id,generation,spec_version,run_id,summary,evidence_refs)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT(execution_id) DO NOTHING`,
        [randomUUID(), input.tenantId, input.sessionId, input.automationId, input.executionId,
          input.incarnationId, input.generation, input.specVersion, input.runId, input.summary,
          JSON.stringify(input.evidenceRefs)],
      );
      return { queued: true };
    });
  }

  private async applyDecisionLocked(
    client: pg.PoolClient,
    job: {
      evaluation_id: string; tenant_id: string; session_id: string; automation_id: string;
      execution_id: string; incarnation_id: string; generation: string | number;
      spec_version: string | number; decision_epoch: string | number; run_id: string;
    },
    evidence: GoalEvidence,
    result: { decision: GoalDecision; reason: string; confidence: number },
    authority: { leaseToken: string } | { providerAttemptId: string },
  ): Promise<boolean> {
    const current = await this.store.getLocked(client, job.tenant_id, job.session_id, job.automation_id);
    const latestGates = await this.resolveHardGates(client, {
      tenantId: job.tenant_id,
      sessionId: job.session_id,
      automationId: job.automation_id,
      executionId: job.execution_id,
      runId: job.run_id,
    });
    const fenced = current
      && current.incarnationId === job.incarnation_id
      && current.generation === Number(job.generation)
      && current.specVersion === Number(job.spec_version)
      && current.status === 'active';
    const decision = result.decision === 'met'
      && (!passesGoalHardGates({ ...evidence, hardGates: latestGates }) || result.confidence < 0.8)
      ? { ...result, decision: 'unverifiable' as const, reason: 'final_gate_or_confidence_failed' }
      : result;
    const updated = 'leaseToken' in authority
      ? await client.query(
        `UPDATE ${this.store.tables.evaluations}
            SET state=$2,decision=$3,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
          WHERE evaluation_id=$1 AND lease_token=$4 AND state='claimed'`,
        [job.evaluation_id, decision.decision, JSON.stringify(decision), authority.leaseToken],
      )
      : await client.query(
        `UPDATE ${this.store.tables.evaluations}
            SET state=$2,decision=$3,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
          WHERE evaluation_id=$1 AND provider_attempt_id=$4
            AND state IN ('claimed','result_unknown')`,
        [job.evaluation_id, decision.decision, JSON.stringify(decision), authority.providerAttemptId],
      );
    if (!updated.rowCount) return false;
    if (!fenced) return true;
    if (decision.decision === 'met') {
      await this.store.beginTerminalDrainLocked(client,current!,'completed','goal_met');
    } else if (decision.decision === 'continue') {
      const epoch = Number(job.decision_epoch) + 1;
      await this.store.scheduleTx(client, {
        tenantId: job.tenant_id,
        sessionId: job.session_id,
        automationId: job.automation_id,
        incarnationId: job.incarnation_id,
        generation: Number(job.generation),
        specVersion: Number(job.spec_version),
        continuationEpoch: epoch,
        triggerKey: `goal:${job.automation_id}:g${job.generation}:e${epoch}`,
        dueAt: new Date(),
        payload: { evaluationId: job.evaluation_id, reason: decision.reason },
      });
    } else {
      await client.query(
        `UPDATE ${this.store.tables.automations}
            SET status='blocked',phase='idle',last_error=$7,control_version=control_version+1,
                projection_version=projection_version+1,updated_at=now()
          WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3
            AND incarnation_id=$4 AND generation=$5 AND spec_version=$6 AND status='active'`,
        [job.tenant_id, job.session_id, job.automation_id, job.incarnation_id,
          job.generation, job.spec_version, decision.reason],
      );
    }
    const next=await this.store.getLocked(client,job.tenant_id,job.session_id,job.automation_id);
    if(next)await this.store.event(client,next,'automation_state_changed',{evaluationId:job.evaluation_id,decision:decision.decision,snapshot:next});
    return true;
  }

  async reconcileUnknown(): Promise<number> {
    let restored = 0;
    const completed = await this.store.pool.query(
      `SELECT e.evaluation_id,e.tenant_id,e.session_id,e.automation_id,e.execution_id,e.incarnation_id,
              e.generation,e.spec_version,e.decision_epoch,e.evidence,x.run_id,p.provider_attempt_id,p.result_payload
         FROM ${this.store.tables.evaluations} e
         JOIN ${this.store.tables.executions} x
           ON x.tenant_id=e.tenant_id AND x.session_id=e.session_id AND x.automation_id=e.automation_id
          AND x.execution_id=e.execution_id AND x.incarnation_id=e.incarnation_id
          AND x.generation=e.generation AND x.spec_version=e.spec_version
         JOIN ${this.store.tables.providerAttempts} p
           ON p.provider_attempt_id=e.provider_attempt_id AND p.tenant_id=e.tenant_id
          AND p.session_id=e.session_id AND p.automation_id=e.automation_id
          AND p.execution_id=e.execution_id AND p.incarnation_id=e.incarnation_id
          AND p.generation=e.generation AND p.run_id=x.run_id
        WHERE ((e.state='claimed' AND e.lease_expires_at<now()) OR e.state='result_unknown')
          AND p.operation='goal-evaluation:'||e.execution_id::text
          AND p.state IN ('response_received','completed')`,
    );
    for (const job of completed.rows) {
      restored += await this.store.tx(async client => {
        const locked = await client.query(
          `SELECT p.state,p.result_payload
             FROM ${this.store.tables.evaluations} e
             JOIN ${this.store.tables.providerAttempts} p ON p.provider_attempt_id=e.provider_attempt_id
            WHERE e.evaluation_id=$1 AND e.provider_attempt_id=$2
              AND ((e.state='claimed' AND e.lease_expires_at<now()) OR e.state='result_unknown')
              AND p.tenant_id=$3 AND p.session_id=$4 AND p.automation_id=$5
              AND p.incarnation_id=$6 AND p.generation=$7 AND p.execution_id=$8 AND p.run_id=$9
              AND p.state IN ('response_received','completed')
            FOR UPDATE OF e,p`,
          [job.evaluation_id, job.provider_attempt_id, job.tenant_id, job.session_id,
            job.automation_id, job.incarnation_id, job.generation, job.execution_id, job.run_id],
        );
        if (!locked.rowCount) return 0;
        const result = parsePersistedGoalDecision(locked.rows[0].result_payload);
        if (!result) {
          const evaluation = await client.query(
            `UPDATE ${this.store.tables.evaluations}
                SET state='unverifiable',decision=$3,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
              WHERE evaluation_id=$1 AND provider_attempt_id=$2
                AND state IN ('claimed','result_unknown')`,
            [job.evaluation_id, job.provider_attempt_id, JSON.stringify({
              decision: 'unverifiable', reason: 'completed_attempt_result_unavailable', confidence: 0,
            })],
          );
          if (!evaluation.rowCount) return 0;
          await client.query(
            `UPDATE ${this.store.tables.automations}
                SET status='reconcile_required',phase='waiting',next_wakeup_at=NULL,last_error=$7,
                    projection_version=projection_version+1,updated_at=now()
              WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3
                AND incarnation_id=$4 AND generation=$5 AND spec_version=$6 AND status='active'`,
            [job.tenant_id, job.session_id, job.automation_id, job.incarnation_id,
              job.generation, job.spec_version, 'completed_attempt_result_unavailable'],
          );
          return 1;
        }
        return await this.applyDecisionLocked(client, job, job.evidence as GoalEvidence, result, {
          providerAttemptId: job.provider_attempt_id,
        }) ? 1 : 0;
      });
    }

    restored += await this.store.tx(async client => {
      const unknown = await client.query(
        `UPDATE ${this.store.tables.evaluations} e
            SET state='result_unknown',provider_attempt_id=p.provider_attempt_id,
                lease_token=NULL,lease_expires_at=NULL,updated_at=now()
           FROM ${this.store.tables.providerAttempts} p
          WHERE e.state='claimed' AND e.lease_expires_at<now()
            AND p.tenant_id=e.tenant_id AND p.session_id=e.session_id AND p.automation_id=e.automation_id
            AND p.execution_id=e.execution_id AND p.incarnation_id=e.incarnation_id AND p.generation=e.generation
            AND p.operation='goal-evaluation:'||e.execution_id::text
            AND p.state IN ('prepared','dispatched','result_unknown','reconcile')
          RETURNING e.evaluation_id`,
      );
      // Also sweep already-handled result_unknown rows: evaluator error handling can
      // persist the evaluation state before a worker dies, so reconciliation authority
      // must not depend on this invocation having performed the claimed transition.
      await client.query(
          `UPDATE ${this.store.tables.providerAttempts} p
              SET state='result_unknown',version=p.version+1,lease_token=NULL,lease_expires_at=NULL,
                  last_error=COALESCE(p.last_error,'evaluator_lease_expired_after_admission'),updated_at=now()
             FROM ${this.store.tables.evaluations} e
            WHERE e.provider_attempt_id=p.provider_attempt_id AND e.state='result_unknown'
              AND p.state IN ('prepared','dispatched')`,
        );
        await client.query(
          `UPDATE ${this.store.tables.budgetReservations} r
              SET state='result_unknown',version=r.version+1,updated_at=now()
             FROM ${this.store.tables.providerAttempts} p,${this.store.tables.evaluations} e
            WHERE e.provider_attempt_id=p.provider_attempt_id AND e.state='result_unknown'
              AND r.tenant_id=p.tenant_id AND r.idempotency_key=p.idempotency_key AND r.state='reserved'`,
        );
        await client.query(
          `UPDATE ${this.store.tables.automations} a
              SET status='reconcile_required',phase='waiting',next_wakeup_at=NULL,projection_version=projection_version+1,updated_at=now()
             FROM ${this.store.tables.evaluations} e
             JOIN ${this.store.tables.executions} x
               ON x.tenant_id=e.tenant_id AND x.session_id=e.session_id AND x.automation_id=e.automation_id
              AND x.execution_id=e.execution_id AND x.incarnation_id=e.incarnation_id
              AND x.generation=e.generation AND x.spec_version=e.spec_version
             JOIN ${this.store.tables.providerAttempts} p
               ON p.provider_attempt_id=e.provider_attempt_id AND p.tenant_id=e.tenant_id
              AND p.session_id=e.session_id AND p.automation_id=e.automation_id
              AND p.execution_id=e.execution_id AND p.incarnation_id=e.incarnation_id
              AND p.generation=e.generation AND p.run_id=x.run_id
            WHERE e.state='result_unknown' AND p.state IN ('result_unknown','reconcile')
              AND a.tenant_id=e.tenant_id AND a.session_id=e.session_id AND a.automation_id=e.automation_id
              AND a.incarnation_id=e.incarnation_id AND a.generation=e.generation AND a.spec_version=e.spec_version
              AND a.status='active'`,
        );
      const retryable = await client.query(
        `UPDATE ${this.store.tables.evaluations} e
            SET state='pending',lease_token=NULL,lease_expires_at=NULL,updated_at=now()
          WHERE e.state='claimed' AND e.lease_expires_at<now()
            AND NOT EXISTS(
              SELECT 1 FROM ${this.store.tables.providerAttempts} p
               WHERE p.tenant_id=e.tenant_id AND p.automation_id=e.automation_id AND p.execution_id=e.execution_id
                 AND p.operation='goal-evaluation:'||e.execution_id::text
                 AND p.state IN ('prepared','dispatched','result_unknown','reconcile')
            )
          RETURNING e.evaluation_id`,
      );
      return (unknown.rowCount ?? 0) + (retryable.rowCount ?? 0);
    });
    return restored;
  }

  private async checkInBlocked(): Promise<number> {
    const blocked = await this.store.pool.query(
      `SELECT e.evaluation_id,e.tenant_id,e.session_id,e.automation_id,e.execution_id,e.incarnation_id,
              e.generation,e.spec_version,e.evidence,x.run_id
         FROM ${this.store.tables.evaluations} e
         JOIN ${this.store.tables.executions} x ON x.execution_id=e.execution_id
        WHERE e.state='blocked' AND e.decision->>'reason'='hard_gate'`,
    );
    let restored = 0;
    for (const job of blocked.rows) {
      restored += await this.store.tx(async client => {
        const current = await this.store.getLocked(client, job.tenant_id, job.session_id, job.automation_id);
        if (!current || current.status !== 'active' || current.incarnationId !== job.incarnation_id
          || current.generation !== Number(job.generation) || current.specVersion !== Number(job.spec_version)) return 0;
        const gates = await this.resolveHardGates(client, {
          tenantId: job.tenant_id, sessionId: job.session_id, automationId: job.automation_id,
          executionId: job.execution_id, runId: job.run_id,
        });
        if (!passesGoalHardGates({ ...job.evidence, hardGates: gates })) return 0;
        const updated = await client.query(
          `UPDATE ${this.store.tables.evaluations}
              SET state='pending',decision=NULL,updated_at=now()
            WHERE evaluation_id=$1 AND state='blocked' AND incarnation_id=$2 AND generation=$3 AND spec_version=$4
            RETURNING evaluation_id`,
          [job.evaluation_id, job.incarnation_id, job.generation, job.spec_version],
        );
        return updated.rowCount ?? 0;
      });
    }
    return restored;
  }

  async evaluatePending(limit = 10): Promise<number> {
    await this.reconcileUnknown();
    await this.checkInBlocked();
    if (!this.executionEnabled()) return 0;
    const jobs = await this.store.tx(async client => {
      const result = await client.query(
        `SELECT e.*,a.owner_user_id,x.run_id
           FROM ${this.store.tables.evaluations} e
           JOIN ${this.store.tables.automations} a
             ON a.tenant_id=e.tenant_id AND a.session_id=e.session_id AND a.automation_id=e.automation_id
            AND a.incarnation_id=e.incarnation_id AND a.generation=e.generation
            AND a.spec_version=e.spec_version AND a.status='active'
           JOIN ${this.store.tables.executions} x
             ON x.tenant_id=e.tenant_id AND x.session_id=e.session_id AND x.automation_id=e.automation_id
            AND x.execution_id=e.execution_id AND x.incarnation_id=e.incarnation_id
            AND x.generation=e.generation AND x.spec_version=e.spec_version
          WHERE e.state='pending' AND x.state='terminal'
          ORDER BY e.created_at FOR UPDATE OF e,a SKIP LOCKED LIMIT $1`,
        [limit],
      );
      for (const job of result.rows) {
        const token = randomUUID();
        await client.query(
          `UPDATE ${this.store.tables.evaluations}
              SET state='claimed',lease_token=$2,lease_expires_at=now()+interval '2 minutes'
            WHERE evaluation_id=$1`,
          [job.evaluation_id, token],
        );
        job.lease_token = token;
      }
      return result.rows;
    });

    for (const job of jobs) {
      const snapshot = await this.store.get(job.tenant_id, job.session_id, job.automation_id);
      if (!snapshot) continue;
      const gates = await this.resolveHardGates(this.store.pool, {
        tenantId: job.tenant_id,
        sessionId: job.session_id,
        automationId: job.automation_id,
        executionId: job.execution_id,
        runId: job.run_id,
      });
      const evidence: GoalEvidence = { ...job.evidence, hardGates: gates };
      if (!passesGoalHardGates(evidence)) {
        await this.store.pool.query(
          `UPDATE ${this.store.tables.evaluations}
              SET state='blocked',decision=$2,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
            WHERE evaluation_id=$1 AND lease_token=$3`,
          [job.evaluation_id, JSON.stringify({ decision: 'blocked', reason: 'hard_gate', confidence: 1, gates }), job.lease_token],
        );
        continue;
      }

      // Close the claim-to-provider race: revalidate the complete automation fence immediately
      // before the evaluator can reserve budget or send provider bytes.
      const admitted = await this.store.pool.query(
        `SELECT 1 FROM ${this.store.tables.evaluations} e
          JOIN ${this.store.tables.automations} a
            ON a.tenant_id=e.tenant_id AND a.session_id=e.session_id AND a.automation_id=e.automation_id
           AND a.incarnation_id=e.incarnation_id AND a.generation=e.generation
           AND a.spec_version=e.spec_version AND a.status='active'
         WHERE e.evaluation_id=$1 AND e.lease_token=$2 AND e.state='claimed'`,
        [job.evaluation_id, job.lease_token],
      );
      if (!admitted.rowCount) {
        await this.store.pool.query(
          `UPDATE ${this.store.tables.evaluations}
              SET state='cancelled',lease_token=NULL,lease_expires_at=NULL,updated_at=now()
            WHERE evaluation_id=$1 AND lease_token=$2 AND state='claimed'`,
          [job.evaluation_id, job.lease_token],
        );
        continue;
      }

      let result: { decision: GoalDecision; reason: string; confidence: number };
      try {
        result = await this.evaluator.evaluate({
          tenantId: job.tenant_id,
          sessionId: job.session_id,
          ownerUserId: job.owner_user_id,
          automationId: job.automation_id,
          executionId: job.execution_id,
          incarnationId: job.incarnation_id,
          generation: Number(job.generation),
          specVersion: Number(job.spec_version),
          condition: snapshot.spec.condition!,
          evidence,
          evaluatorRunId: `automation-evaluator-${job.evaluation_id}`,
          executionRunId: job.run_id,
          onAttemptPrepared: async (providerAttemptId) => {
            await this.store.pool.query(
              `UPDATE ${this.store.tables.evaluations}
                  SET provider_attempt_id=$2,updated_at=now()
                WHERE evaluation_id=$1 AND lease_token=$3 AND state='claimed'`,
              [job.evaluation_id, providerAttemptId, job.lease_token],
            );
          },
        });
      } catch (error) {
        const resultUnknown = error instanceof GoalEvaluationResultUnknownError;
        await this.store.pool.query(
          `UPDATE ${this.store.tables.evaluations}
              SET state=$2,decision=$3,provider_attempt_id=COALESCE($4,provider_attempt_id),
                  lease_token=NULL,lease_expires_at=NULL,updated_at=now()
            WHERE evaluation_id=$1 AND lease_token=$5`,
          [job.evaluation_id, resultUnknown ? 'result_unknown' : 'pending',
            JSON.stringify({ reason: error instanceof Error ? error.message : String(error) }),
            resultUnknown ? error.providerAttemptId : null, job.lease_token],
        );
        continue;
      }

      await this.store.tx(client => this.applyDecisionLocked(
        client, job, evidence, result, { leaseToken: job.lease_token },
      ));
      const published=await this.store.get(job.tenant_id,job.session_id,job.automation_id);if(published)this.store.publish(published);
    }
    return jobs.length;
  }

  start(pollMs = 2_000): void {
    if (this.timer) return;
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try { await this.evaluatePending(); } finally { this.running = false; }
    };
    void tick();
    this.timer = setInterval(() => void tick(), pollMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    while (this.running) await new Promise(resolve => setTimeout(resolve, 10));
  }
}
