import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { BillingService } from '../data/billing/service.js';
import type { ModelProviderOptions } from '../types/index.js';
import type { ModelAdapter, RunContext } from './types.js';
import type { PgSessionAutomationStore } from './sessionAutomationStore.js';

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
  }): Promise<{ decision: GoalDecision; reason: string; confidence: number }>;
}

export function passesGoalHardGates(evidence: GoalEvidence): boolean {
  return evidence.hardGates.runTerminal
    && evidence.hardGates.noPendingInteraction
    && evidence.hardGates.noActiveResources
    && evidence.hardGates.budgetValid
    && evidence.evidenceRefs.length > 0;
}

export function progressFingerprint(input: { summary?: string; evidenceRefs?: string[]; terminalStatus?: string }): string {
  return createHash('sha256').update(JSON.stringify({
    summary: input.summary?.trim(),
    evidenceRefs: [...(input.evidenceRefs ?? [])].sort(),
    terminalStatus: input.terminalStatus,
  })).digest('hex');
}

export function reduceNoProgress(previous: string | undefined, current: string, count: number, threshold = 3): { count: number; pause: boolean } {
  const next = previous === current ? count + 1 : 0;
  return { count: next, pause: next >= threshold };
}

/** Independent utility-model evaluator; it is not the primary automation agent. */
export class ModelGoalEvaluator implements GoalEvaluatorPort {
  constructor(private readonly options: {
    resolveModel: (tenantId: string) => { model: string; connection?: { apiKey?: string; baseUrl?: string }; providerOptions?: ModelProviderOptions } | null;
    createAdapter: (connection: { apiKey?: string; baseUrl?: string } | undefined, options?: ModelProviderOptions) => ModelAdapter;
    billing: () => BillingService | undefined;
    resolveIdentity: (userId: string) => { username: string } | undefined;
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
    const evaluatorRunId = `automation-evaluator-${randomUUID()}`;
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
      },
      ...(billing ? { authorizeModelTurn: billing.beforeModelCall } : {}),
    };
    let text = '';
    let completed = false;
    try {
      for await (const event of adapter.stream({
        model: resolved.model,
        messages: [
          { role: 'system', content: 'You are an independent completion verifier. Never trust a claimant assertion without evidence. Return only JSON: {"decision":"met|continue|blocked|unverifiable","reason":"...","confidence":0..1}.' },
          { role: 'user', content: JSON.stringify({ completionCondition: input.condition, evidence: input.evidence }) },
        ],
        tools: [],
        toolChoice: 'none',
        maxOutputTokens: 500,
        signal: new AbortController().signal,
      }, context)) {
        if (event.type === 'text_delta') text += event.content;
        if (event.type === 'completed') {
          completed = true;
          text = event.content || text;
          if (event.usage && billing) await billing.recordUsage(resolved.model, event.usage);
          if (event.terminalStatus && event.terminalStatus !== 'completed') throw new Error(`result_unknown:${event.terminalStatus}`);
        }
      }
      if (!completed) throw new Error('result_unknown:no_terminal_result');
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (!['met', 'continue', 'blocked', 'unverifiable'].includes(String(parsed.decision))
        || typeof parsed.reason !== 'string' || typeof parsed.confidence !== 'number') {
        throw new Error('result_unknown:invalid_evaluator_json');
      }
      return {
        decision: parsed.decision as GoalDecision,
        reason: parsed.reason,
        confidence: Math.max(0, Math.min(1, parsed.confidence)),
      };
    } finally {
      await billing?.finalize();
    }
  }
}

export class SessionAutomationEvaluator {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly eventsTable: string;

  constructor(readonly store: PgSessionAutomationStore, readonly evaluator: GoalEvaluatorPort) {
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
    const automation = await client.query(
      `SELECT limit_hit_reason FROM ${this.store.tables.automations}
        WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3`,
      [input.tenantId, input.sessionId, input.automationId],
    );
    const budgetReason = await this.store.budgetReasonTx(client as pg.PoolClient, input.tenantId, input.sessionId, input.automationId);
    return {
      runTerminal: execution.rows[0]?.state === 'terminal',
      noPendingInteraction: pendingInteraction.rows[0]?.pending !== true,
      noActiveResources: Number(active.rows[0]?.count ?? 0) === 0,
      budgetValid: !automation.rows[0]?.limit_hit_reason && budgetReason !== 'expires_at',
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
    const snapshot = await this.store.get(input.tenantId, input.sessionId, input.automationId);
    if (!snapshot || snapshot.spec.kind !== 'goal' || snapshot.status !== 'active'
      || snapshot.activeRunId !== input.runId || snapshot.incarnationId !== input.incarnationId
      || snapshot.generation !== input.generation || snapshot.specVersion !== input.specVersion) {
      return { queued: false, reason: 'stale_fence' };
    }
    if (input.evidenceRefs.length === 0) return { queued: false, reason: 'hard_gate' };
    const gates = await this.resolveHardGates(this.store.pool, input);
    const evidence: GoalEvidence = { summary: input.summary, evidenceRefs: input.evidenceRefs, hardGates: gates };
    await this.store.pool.query(
      `INSERT INTO ${this.store.tables.evaluations}
        (evaluation_id,tenant_id,session_id,automation_id,execution_id,incarnation_id,generation,spec_version,decision_epoch,evidence)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT(tenant_id,automation_id,generation,decision_epoch) DO NOTHING`,
      [randomUUID(), input.tenantId, input.sessionId, input.automationId, input.executionId,
        input.incarnationId, input.generation, input.specVersion, Date.now(), JSON.stringify(evidence)],
    );
    return { queued: true };
  }

  async reconcileUnknown(): Promise<number> {
    const result = await this.store.pool.query(
      `UPDATE ${this.store.tables.evaluations}
          SET state='pending',lease_token=NULL,lease_expires_at=NULL,updated_at=now()
        WHERE state IN ('claimed','result_unknown') AND lease_expires_at<now()
        RETURNING evaluation_id`,
    );
    return result.rowCount ?? 0;
  }

  async evaluatePending(limit = 10): Promise<number> {
    await this.reconcileUnknown();
    const jobs = await this.store.tx(async client => {
      const result = await client.query(
        `SELECT e.*,a.owner_user_id,x.run_id
           FROM ${this.store.tables.evaluations} e
           JOIN ${this.store.tables.automations} a USING(automation_id)
           JOIN ${this.store.tables.executions} x ON x.execution_id=e.execution_id
          WHERE e.state='pending' AND x.state='terminal'
          ORDER BY e.created_at FOR UPDATE OF e SKIP LOCKED LIMIT $1`,
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
        });
      } catch (error) {
        await this.store.pool.query(
          `UPDATE ${this.store.tables.evaluations}
              SET state='result_unknown',decision=$2,lease_expires_at=now()+interval '1 minute',updated_at=now()
            WHERE evaluation_id=$1 AND lease_token=$3`,
          [job.evaluation_id, JSON.stringify({ reason: error instanceof Error ? error.message : String(error) }), job.lease_token],
        );
        continue;
      }

      await this.store.tx(async client => {
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
        const decision = result.decision === 'met' && (!passesGoalHardGates({ ...evidence, hardGates: latestGates }) || result.confidence < 0.8)
          ? { ...result, decision: 'unverifiable' as const, reason: 'final_gate_or_confidence_failed' }
          : result;
        await client.query(
          `UPDATE ${this.store.tables.evaluations}
              SET state=$2,decision=$3,lease_token=NULL,lease_expires_at=NULL,updated_at=now()
            WHERE evaluation_id=$1 AND lease_token=$4`,
          [job.evaluation_id, decision.decision, JSON.stringify(decision), job.lease_token],
        );
        if (!fenced) return;
        if (decision.decision === 'met') {
          await client.query(
            `UPDATE ${this.store.tables.automations}
                SET status='completed',phase='terminal',active_run_id=NULL,next_wakeup_at=NULL,
                    control_version=control_version+1,projection_version=projection_version+1,updated_at=now()
              WHERE tenant_id=$1 AND automation_id=$2 AND generation=$3 AND incarnation_id=$4`,
            [job.tenant_id, job.automation_id, job.generation, job.incarnation_id],
          );
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
                SET status='blocked',phase='idle',last_error=$3,control_version=control_version+1,
                    projection_version=projection_version+1,updated_at=now()
              WHERE tenant_id=$1 AND automation_id=$2`,
            [job.tenant_id, job.automation_id, decision.reason],
          );
        }
        const next=await this.store.getLocked(client,job.tenant_id,job.session_id,job.automation_id);
        if(next)await this.store.event(client,next,'automation_state_changed',{evaluationId:job.evaluation_id,decision:decision.decision,snapshot:next});
      });
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
