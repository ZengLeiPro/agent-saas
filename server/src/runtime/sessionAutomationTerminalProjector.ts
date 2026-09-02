import { randomUUID } from 'node:crypto';
import type { PgEventStore } from './pgEventStore.js';
import type { SdkResultModelUsage } from '../agent/types.js';
import type { PlatformEvent } from './types.js';
import { extractRunProgressEvidence, reduceNoProgress } from './sessionAutomationBudgetProgress.js';
import type { PgSessionAutomationStore } from './sessionAutomationStore.js';
import { SessionAutomationEvaluator, type GoalEvaluatorPort } from './sessionAutomationEvaluator.js';
import { computeUsageTotalTokens } from '../data/usage/pricing.js';

export interface AutomationTerminalEvent {
  globalSequence: number;
  tenantId: string;
  sessionId: string;
  runId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'orphaned' | 'interrupted';
  summary?: string;
  evidenceRefs?: string[];
  progressFingerprint?: string;
  numTurns?: number;
  modelUsage?: Record<string, SdkResultModelUsage>;
  /** Terminal fact recovered from run_state_changed without a run_finished usage aggregate. */
  stateOnly?: boolean;
}

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function totalTokens(modelUsage?: Record<string, SdkResultModelUsage>): number {
  return Object.entries(modelUsage ?? {}).reduce((total, [model, usage]) => total
    + computeUsageTotalTokens(model, {
      inputTokens: nonNegativeInteger(usage.inputTokens),
      outputTokens: nonNegativeInteger(usage.outputTokens),
      cacheReadTokens: nonNegativeInteger(usage.cacheReadInputTokens),
      cacheCreationTokens: nonNegativeInteger(usage.cacheCreationInputTokens),
    }), 0);
}

function nextContinuationEpoch(value: unknown): number {
  const epoch = Number(value);
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('invalid_wakeup_continuation_epoch');
  return epoch + 1;
}

export class SessionAutomationTerminalProjector {
  private timer?: NodeJS.Timeout;
  private running = false;

  private readonly evidenceValidator: SessionAutomationEvaluator;
  constructor(
    readonly store: PgSessionAutomationStore,
    readonly consumerName = 'session-automation-terminal-v2',
    readonly noProgressThreshold = 3,
  ) {
    const unavailable: GoalEvaluatorPort = { evaluate: async () => { throw new Error('evaluator_unavailable'); } };
    this.evidenceValidator = new SessionAutomationEvaluator(store, unavailable, () => false);
  }

  async cursor(): Promise<number> {
    await this.store.pool.query(
      `INSERT INTO ${this.store.tables.consumers}(consumer_name,last_global_sequence) VALUES($1,0) ON CONFLICT DO NOTHING`,
      [this.consumerName],
    );
    const result = await this.store.pool.query(
      `SELECT last_global_sequence FROM ${this.store.tables.consumers} WHERE consumer_name=$1`,
      [this.consumerName],
    );
    return Number(result.rows[0]?.last_global_sequence ?? 0);
  }

  async project(event: AutomationTerminalEvent): Promise<boolean> {
    return this.store.tx(async client => {
      await client.query(
        `INSERT INTO ${this.store.tables.consumers}(consumer_name,last_global_sequence) VALUES($1,0) ON CONFLICT DO NOTHING`,
        [this.consumerName],
      );
      const cursor = await client.query(
        `SELECT last_global_sequence FROM ${this.store.tables.consumers} WHERE consumer_name=$1 FOR UPDATE`,
        [this.consumerName],
      );
      if (Number(cursor.rows[0]?.last_global_sequence) >= event.globalSequence) return false;

      const execution = await client.query(
        `SELECT e.*,w.due_at AS wakeup_due_at,w.continuation_epoch AS wakeup_continuation_epoch,
                w.trigger_key AS wakeup_trigger_key,
                a.status,a.mode,a.active_run_id,a.desired_terminal_status,a.no_progress_count,a.last_progress_fingerprint,
                a.incarnation_id AS current_incarnation,a.generation AS current_generation,
                a.control_version AS current_control_version,a.continuation_epoch AS current_continuation_epoch,s.spec
           FROM ${this.store.tables.executions} e
           JOIN ${this.store.tables.outbox} o ON o.outbox_id=e.outbox_id
           JOIN ${this.store.tables.wakeups} w ON w.wakeup_id=o.wakeup_id
           JOIN ${this.store.tables.automations} a
             ON a.tenant_id=e.tenant_id
            AND a.session_id=e.session_id
            AND a.automation_id=e.automation_id
           JOIN ${this.store.tables.specs} s
             ON s.tenant_id=a.tenant_id
            AND s.session_id=a.session_id
            AND s.automation_id=a.automation_id
            AND s.spec_version=a.spec_version
          WHERE e.tenant_id=$1 AND e.session_id=$2 AND e.run_id=$3
          FOR UPDATE OF e,a`,
        [event.tenantId, event.sessionId, event.runId],
      );
      const row = execution.rows[0];
      if (row) {
        // Capture the durable execution phase before terminal projection mutates it. A prepared
        // execution with no provider/reservation facts is the only state-only pre-model proof.
        const executionState = String(row.state);
        const fingerprint = event.progressFingerprint
          ?? extractRunProgressEvidence([], event.status).fingerprint;
        const noProgress = reduceNoProgress(
          row.last_progress_fingerprint,
          fingerprint,
          Number(row.no_progress_count),
          this.noProgressThreshold,
        );
        await client.query(
          `UPDATE ${this.store.tables.executions}
              SET state='terminal',terminal_status=$2,progress_fingerprint=$3,updated_at=now()
            WHERE execution_id=$1`,
          [row.execution_id, event.status, fingerprint],
        );
        await client.query(`UPDATE ${this.store.tables.outbox} SET state='completed' WHERE outbox_id=$1`, [row.outbox_id]);
        await client.query(
          `UPDATE ${this.store.tables.preparedDispatchAttempts}
              SET state='completed',version=version+1,lease_token=NULL,lease_expires_at=NULL,
                  completed_at=COALESCE(completed_at, now()),updated_at=now()
            WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3
              AND incarnation_id=$4 AND generation=$5 AND execution_id=$6
              AND run_id=$7 AND outbox_id=$8
              AND state IN ('prepared','dispatched','result_unknown','reconcile')`,
          [event.tenantId, event.sessionId, row.automation_id, row.incarnation_id,
            row.generation, row.execution_id, event.runId, row.outbox_id],
        );
        await client.query(
          `UPDATE ${this.store.tables.wakeups} SET state='consumed'
            WHERE wakeup_id=(SELECT wakeup_id FROM ${this.store.tables.outbox} WHERE outbox_id=$1)`,
          [row.outbox_id],
        );
        const terminalTurns = nonNegativeInteger(event.numTurns);
        const terminalTokens = totalTokens(event.modelUsage);
        // Turns/tokens are comparable aggregates, so persist only their positive terminal gap.
        // Credits are deliberately zero here: SDK costUSD is non-authoritative and cannot be
        // subtracted from provider-priced microcredits. Authoritative credits are written only by
        // provider reservation settlement (the source_kind='model' ledger row).
        await client.query(
          `WITH provider AS (
             SELECT COALESCE(SUM(turns),0) AS turns,COALESCE(SUM(tokens),0) AS tokens
               FROM ${this.store.tables.usage}
              WHERE tenant_id=$1 AND automation_id=$2 AND execution_id=$3 AND source_kind='model'
           )
           INSERT INTO ${this.store.tables.usage}
             (usage_id,tenant_id,session_id,automation_id,execution_id,source_key,source_kind,turns,tokens,credits)
           SELECT $4,$1,$5,$2,$3,$6,'automation_run',
                  GREATEST($7::bigint-provider.turns,0),
                  GREATEST($8::bigint-provider.tokens,0),0
             FROM provider
           ON CONFLICT(tenant_id,automation_id,source_key) DO NOTHING`,
          [event.tenantId, row.automation_id, row.execution_id, randomUUID(), event.sessionId,
            `run:${event.runId}`, terminalTurns, terminalTokens],
        );

        // SDK aggregates never authorize credits. Under maxCredits, state-only terminals and any
        // terminal reporting model usage must prove each durable work attempt independently:
        // completed => settled credits reservation + charged settlement + matching model usage;
        // cancelled => released credits reservation; every other attempt state is unresolved.
        // With no attempt facts, only a still-prepared execution with no work reservation proves the
        // provider boundary was never reached. This intentionally fails closed for running legacy
        // state-only executions whose model/ledger chain is missing.
        let creditsUnverifiable = false;
        const creditBudgetEnabled = row.spec?.budget?.maxCredits !== undefined;
        if (creditBudgetEnabled && (event.stateOnly || terminalTurns > 0 || terminalTokens > 0)) {
          const creditAuthority = await client.query<{
            state: string;
            completed_authoritative: boolean;
            cancelled_authoritative: boolean;
          }>(
            `SELECT p.state,
                    (p.state='completed' AND EXISTS (
                      SELECT 1 FROM ${this.store.tables.budgetReservations} r
                      JOIN ${this.store.tables.budgetSettlements} s
                        ON s.reservation_id=r.reservation_id AND s.outcome='charged'
                      JOIN ${this.store.tables.usage} u
                        ON u.tenant_id=p.tenant_id AND u.automation_id=p.automation_id
                       AND u.execution_id=p.execution_id AND u.source_kind='model'
                       AND u.source_key=p.idempotency_key AND u.credits=s.amount
                     WHERE r.tenant_id=p.tenant_id AND r.automation_id=p.automation_id
                       AND r.execution_id=p.execution_id AND r.run_id=p.run_id
                       AND r.budget_kind='credits' AND r.purpose='work' AND r.state='settled'
                       AND r.idempotency_key=p.idempotency_key||':credits'
                    )) AS completed_authoritative,
                    (p.state='cancelled' AND EXISTS (
                      SELECT 1 FROM ${this.store.tables.budgetReservations} r
                       WHERE r.tenant_id=p.tenant_id AND r.automation_id=p.automation_id
                         AND r.execution_id=p.execution_id AND r.run_id=p.run_id
                         AND r.budget_kind='credits' AND r.purpose='work' AND r.state='released'
                         AND r.idempotency_key=p.idempotency_key||':credits'
                    )) AS cancelled_authoritative
               FROM ${this.store.tables.providerAttempts} p
              WHERE p.tenant_id=$1 AND p.automation_id=$2 AND p.execution_id=$3
                AND p.provider='model' AND COALESCE(p.request_payload->>'purpose','work')='work'`,
            [event.tenantId, row.automation_id, row.execution_id],
          );
          if (creditAuthority.rows.length === 0) {
            const reservations = await client.query(
              `SELECT 1 FROM ${this.store.tables.budgetReservations}
                WHERE tenant_id=$1 AND automation_id=$2 AND execution_id=$3 AND purpose='work' LIMIT 1`,
              [event.tenantId, row.automation_id, row.execution_id],
            );
            creditsUnverifiable = executionState !== 'prepared' || Boolean(reservations.rowCount);
          } else {
            creditsUnverifiable = creditAuthority.rows.some(attempt =>
              attempt.state === 'completed' ? !attempt.completed_authoritative
                : attempt.state === 'cancelled' ? !attempt.cancelled_authoritative
                  : true,
            );
          }
        }

        const ownsActiveRun = row.active_run_id === event.runId;
        const fenced = row.incarnation_id === row.current_incarnation
          && Number(row.generation) === Number(row.current_generation);
        if (ownsActiveRun && fenced && creditsUnverifiable) {
          await client.query(
            `UPDATE ${this.store.tables.automations}
                SET status='reconcile_required',phase='waiting',active_run_id=NULL,next_wakeup_at=NULL,
                    projection_version=projection_version+1,updated_at=now()
              WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND active_run_id=$4
                AND incarnation_id=$5 AND generation=$6`,
            [event.tenantId,event.sessionId,row.automation_id,event.runId,row.incarnation_id,row.generation],
          );
        } else if (ownsActiveRun && fenced && row.desired_terminal_status) {
          await client.query(
            `UPDATE ${this.store.tables.automations}
                SET phase='draining',active_run_id=NULL,next_wakeup_at=NULL,
                    projection_version=projection_version+1,updated_at=now()
              WHERE tenant_id=$1 AND automation_id=$2 AND active_run_id=$3
                AND incarnation_id=$4 AND generation=$5`,
            [event.tenantId, row.automation_id, event.runId, row.incarnation_id, row.generation],
          );
          await client.query(
            `UPDATE ${this.store.tables.cancellations}
                SET state='completed',lease_token=NULL,lease_expires_at=NULL,updated_at=now()
              WHERE tenant_id=$1 AND run_id=$2 AND state<>'dead'`,
            [event.tenantId, event.runId],
          );
          await client.query(
            `UPDATE ${this.store.tables.lifecycleWork}
                SET state='completed',lease_token=NULL,lease_expires_at=NULL,updated_at=now()
              WHERE tenant_id=$1 AND automation_id=$2 AND object_type='run' AND object_id=$3 AND state IN ('pending','claimed')`,
            [event.tenantId, row.automation_id, event.runId],
          );
        } else if (ownsActiveRun && row.status === 'paused') {
          await client.query(
            `UPDATE ${this.store.tables.automations}
                SET phase='idle',active_run_id=NULL,no_progress_count=$3,last_progress_fingerprint=$4,
                    projection_version=projection_version+1,updated_at=now()
              WHERE tenant_id=$1 AND automation_id=$2 AND active_run_id=$5`,
            [event.tenantId, row.automation_id, noProgress.count, fingerprint, event.runId],
          );
        } else if (ownsActiveRun && fenced && row.status === 'active') {
          if (noProgress.pause) {
            await client.query(
              `UPDATE ${this.store.tables.automations}
                  SET status='paused',phase='idle',active_run_id=NULL,no_progress_count=$3,
                      last_progress_fingerprint=$4,last_error='no_progress',control_version=control_version+1,
                      projection_version=projection_version+1,updated_at=now()
                WHERE tenant_id=$1 AND automation_id=$2 AND active_run_id=$5`,
              [event.tenantId, row.automation_id, noProgress.count, fingerprint, event.runId],
            );
          } else if (row.mode === 'fixed' && !String(row.wakeup_trigger_key).startsWith('manual:')) {
            const interval = Number(row.spec.intervalMs);
            const anchorDueAt = new Date(row.wakeup_due_at).getTime();
            const elapsedSlots = Math.floor((Date.now() - anchorDueAt) / interval) + 1;
            const slotsToAdvance = Math.max(1, elapsedSlots);
            const slot = Number(row.wakeup_continuation_epoch) + slotsToAdvance;
            await this.store.scheduleTx(client, {
              tenantId: event.tenantId,
              sessionId: event.sessionId,
              automationId: row.automation_id,
              incarnationId: row.current_incarnation,
              generation: Number(row.current_generation),
              specVersion: Number(row.spec_version),
              continuationEpoch: slot,
              triggerKey: `fixed:${row.automation_id}:g${row.generation}:slot${slot}`,
              dueAt: new Date(anchorDueAt + slotsToAdvance * interval),
              payload: { sourceRunId: event.runId },
            });
            await client.query(
              `UPDATE ${this.store.tables.automations}
                  SET phase='waiting',active_run_id=NULL,continuation_epoch=$6,
                      no_progress_count=$3,last_progress_fingerprint=$4,
                      projection_version=projection_version+1,updated_at=now()
                WHERE tenant_id=$1 AND automation_id=$2 AND active_run_id=$5`,
              [event.tenantId, row.automation_id, noProgress.count, fingerprint, event.runId, slot],
            );
          } else {
            await client.query(
              `UPDATE ${this.store.tables.automations}
                  SET phase=CASE WHEN EXISTS (
                        SELECT 1 FROM ${this.store.tables.wakeups} w
                         WHERE w.tenant_id=$1 AND w.automation_id=$2 AND w.incarnation_id=$6
                           AND w.generation=$7 AND w.spec_version=$8 AND w.state IN ('pending','claimed')
                      ) THEN 'waiting' ELSE 'idle' END,
                      active_run_id=NULL,no_progress_count=$3,last_progress_fingerprint=$4,
                      projection_version=projection_version+1,updated_at=now()
                WHERE tenant_id=$1 AND automation_id=$2 AND active_run_id=$5`,
              [event.tenantId,row.automation_id,noProgress.count,fingerprint,event.runId,
                row.current_incarnation,row.current_generation,row.spec_version],
            );
          }

          if (row.mode === 'goal' && !noProgress.pause) {
            const candidate = await client.query(
              `SELECT evidence_manifest,evidence_manifest_hash,projected_at,rejection_reason
                 FROM ${this.store.tables.goalCompletionCandidates}
                WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND execution_id=$4
                  AND run_id=$5 AND incarnation_id=$6 AND generation=$7 AND spec_version=$8`,
              [event.tenantId,event.sessionId,row.automation_id,row.execution_id,event.runId,
                row.current_incarnation,row.current_generation,row.spec_version],
            );
            const frozen = candidate.rows[0];
            const existingEvaluation = await client.query(
              `SELECT evaluation_id FROM ${this.store.tables.evaluations}
                WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND execution_id=$4
                  AND incarnation_id=$5 AND generation=$6 AND spec_version=$7`,
              [event.tenantId,event.sessionId,row.automation_id,row.execution_id,row.current_incarnation,
                row.current_generation,row.spec_version],
            );
            let evaluating = Number(existingEvaluation.rowCount) > 0;
            if (!evaluating && frozen && !frozen.projected_at) {
              const validation = await this.evidenceValidator.validateEvidenceManifest(
                client,frozen.evidence_manifest,String(frozen.evidence_manifest_hash),{
                  tenantId:event.tenantId,sessionId:event.sessionId,automationId:row.automation_id,
                  executionId:row.execution_id,incarnationId:row.current_incarnation,
                  generation:Number(row.current_generation),specVersion:Number(row.spec_version),
                  runId:event.runId,throughGlobalSequence:event.globalSequence,
                },
              );
              if (validation.valid) {
                // Resolve candidate/continuation authority before publishing evaluating phase.
                const locked = await this.store.getLocked(client,event.tenantId,event.sessionId,row.automation_id);
                if (locked) await this.store.supersedeActiveWakeupsLocked(client,locked,'goal_candidate_projected');
                const evaluation = await client.query(
                  `INSERT INTO ${this.store.tables.evaluations}
                    (evaluation_id,tenant_id,session_id,automation_id,execution_id,incarnation_id,generation,spec_version,decision_epoch,evidence,evidence_manifest,evidence_manifest_hash)
                   SELECT $1,c.tenant_id,c.session_id,c.automation_id,c.execution_id,c.incarnation_id,c.generation,c.spec_version,$2,
                          jsonb_build_object('summary',c.summary,'evidenceManifest',c.evidence_manifest,
                            'hardGates',jsonb_build_object('runTerminal',true,'noPendingInteraction',false,'noActiveResources',false,'budgetValid',false)),
                          c.evidence_manifest,c.evidence_manifest_hash
                     FROM ${this.store.tables.goalCompletionCandidates} c
                    WHERE c.tenant_id=$3 AND c.session_id=$4 AND c.automation_id=$5 AND c.execution_id=$6
                      AND c.run_id=$7 AND c.incarnation_id=$8 AND c.generation=$9 AND c.spec_version=$10
                      AND c.projected_at IS NULL AND c.evidence_manifest_hash=$11
                      AND NOT EXISTS (SELECT 1 FROM ${this.store.tables.evaluations} e WHERE e.execution_id=c.execution_id)
                   ON CONFLICT(tenant_id,automation_id,generation,decision_epoch) DO NOTHING RETURNING evaluation_id`,
                  [randomUUID(),event.globalSequence,event.tenantId,event.sessionId,row.automation_id,row.execution_id,
                    event.runId,row.current_incarnation,row.current_generation,row.spec_version,frozen.evidence_manifest_hash],
                );
                evaluating = Number(evaluation.rowCount) > 0 || Boolean((await client.query(
                  `SELECT 1 FROM ${this.store.tables.evaluations} WHERE execution_id=$1 AND incarnation_id=$2 AND generation=$3 AND spec_version=$4`,
                  [row.execution_id,row.current_incarnation,row.current_generation,row.spec_version],
                )).rowCount);
                if (evaluating) await client.query(
                  `UPDATE ${this.store.tables.goalCompletionCandidates} SET projected_at=COALESCE(projected_at,now())
                    WHERE execution_id=$1 AND tenant_id=$2 AND session_id=$3 AND automation_id=$4
                      AND incarnation_id=$5 AND generation=$6 AND spec_version=$7`,
                  [row.execution_id,event.tenantId,event.sessionId,row.automation_id,row.current_incarnation,
                    row.current_generation,row.spec_version],
                );
              } else {
                await client.query(
                  `UPDATE ${this.store.tables.goalCompletionCandidates} SET projected_at=now(),rejection_reason=$2
                    WHERE execution_id=$1 AND tenant_id=$3 AND session_id=$4 AND automation_id=$5
                      AND incarnation_id=$6 AND generation=$7 AND spec_version=$8 AND projected_at IS NULL`,
                  [row.execution_id,validation.reason??'evidence_manifest_invalid',event.tenantId,event.sessionId,
                    row.automation_id,row.current_incarnation,row.current_generation,row.spec_version],
                );
              }
            }
            if (evaluating) {
              const locked = await this.store.getLocked(client,event.tenantId,event.sessionId,row.automation_id);
              if (locked) await this.store.supersedeActiveWakeupsLocked(client,locked,'goal_evaluation_authoritative');
              await client.query(
                `UPDATE ${this.store.tables.automations} SET phase='evaluating',next_wakeup_at=NULL,
                    projection_version=projection_version+1,updated_at=now()
                  WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND incarnation_id=$4
                    AND generation=$5 AND spec_version=$6 AND status='active' AND active_run_id IS NULL`,
                [event.tenantId,event.sessionId,row.automation_id,row.current_incarnation,
                  row.current_generation,row.spec_version],
              );
            } else {
              const successor = await client.query(
                `SELECT 1 FROM ${this.store.tables.wakeups}
                  WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND incarnation_id=$4
                    AND generation=$5 AND spec_version=$6 AND state IN ('pending','claimed') LIMIT 1`,
                [event.tenantId,event.sessionId,row.automation_id,row.current_incarnation,
                  row.current_generation,row.spec_version],
              );
              if (!successor.rowCount) {
                const epoch=nextContinuationEpoch(row.current_continuation_epoch);
                await this.store.scheduleTx(client,{
                  tenantId:event.tenantId,sessionId:event.sessionId,automationId:row.automation_id,
                  incarnationId:row.current_incarnation,generation:Number(row.current_generation),
                  specVersion:Number(row.spec_version),continuationEpoch:epoch,
                  triggerKey:`goal:${row.automation_id}:g${row.current_generation}:e${epoch}:from:${event.runId}:no_checkpoint`,
                  dueAt:new Date(),payload:{sourceRunId:event.runId,reason:frozen?.rejection_reason??'no_checkpoint'},
                });
                await client.query(
                  `UPDATE ${this.store.tables.automations} SET phase='waiting',continuation_epoch=$7,
                      projection_version=projection_version+1,updated_at=now()
                    WHERE tenant_id=$1 AND session_id=$2 AND automation_id=$3 AND incarnation_id=$4
                      AND generation=$5 AND spec_version=$6 AND status='active' AND active_run_id IS NULL`,
                  [event.tenantId,event.sessionId,row.automation_id,row.current_incarnation,
                    row.current_generation,row.spec_version,epoch],
                );
              }
            }
          }
        }
        if(fenced)await this.store.tryFinalizeLocked(client,event.tenantId,event.sessionId,row.automation_id);
        const next=await this.store.getLocked(client,event.tenantId,event.sessionId,row.automation_id);
        if(next&&fenced){
          await this.store.event(client,next,'automation_execution_changed',{runId:event.runId,status:event.status,snapshot:next});
          this.store.publish(next,'automation_execution_changed');
        }
      }

      await client.query(
        `UPDATE ${this.store.tables.consumers}
            SET last_global_sequence=$2,updated_at=now() WHERE consumer_name=$1`,
        [this.consumerName, event.globalSequence],
      );
      return true;
    });
  }

  /** Explicit administration path for a proven deterministic, unrecoverable event only. */
  async quarantine(sequence: number, event: PlatformEvent, error: unknown): Promise<void> {
    await this.store.tx(async client => {
      await client.query(
        `INSERT INTO ${this.store.tables.poison}(consumer_name,global_sequence,event_json,last_error)
         VALUES($1,$2,$3,$4)
         ON CONFLICT(consumer_name,global_sequence) DO UPDATE
           SET attempts=${this.store.tables.poison}.attempts+1,last_error=EXCLUDED.last_error,quarantined_at=now()`,
        [this.consumerName, sequence, JSON.stringify(event), error instanceof Error ? error.message : String(error)],
      );
      await client.query(
        `INSERT INTO ${this.store.tables.consumers}(consumer_name,last_global_sequence) VALUES($1,$2)
         ON CONFLICT(consumer_name) DO UPDATE
           SET last_global_sequence=GREATEST(${this.store.tables.consumers}.last_global_sequence,EXCLUDED.last_global_sequence),updated_at=now()`,
        [this.consumerName, sequence],
      );
    });
  }

  private async progressEvidence(eventStore: PgEventStore, event: AutomationTerminalEvent): Promise<AutomationTerminalEvent> {
    const events: PlatformEvent[] = [];
    let afterCursor: string | undefined;
    do {
      const page = await eventStore.listPage(event.tenantId, event.sessionId, {
        ...(afterCursor ? { afterCursor } : {}),
        limit: 500,
        runId: event.runId,
      });
      events.push(...page.events);
      afterCursor = page.nextCursor;
      if (!page.hasMore) break;
    } while (afterCursor);
    const evidence = extractRunProgressEvidence(events, event.status);
    return { ...event, ...evidence, progressFingerprint: evidence.fingerprint };
  }

  async recover(eventStore: PgEventStore, limit = 500): Promise<number> {
    let processed = 0;
    let after = await this.cursor();
    for (;;) {
      const page = await eventStore.listGlobalPage({
        afterGlobalSequence: after,
        types: ['run_finished', 'run_state_changed'],
        limit,
      });
      if (!page.events.length) break;
      for (const envelope of page.events) {
        if (envelope.globalSequence <= after) throw new Error(`terminal stream gap/regression: ${envelope.globalSequence} <= ${after}`);
        after = envelope.globalSequence;
        const event = envelope.event;
        let terminal: AutomationTerminalEvent | undefined;
        if (event.type === 'run_finished') {
          terminal = {
            globalSequence: after,
            tenantId: envelope.tenantId,
            sessionId: envelope.sessionId,
            runId: event.runId,
            status: event.subtype === 'success' ? 'completed' : event.subtype === 'error' ? 'failed' : 'interrupted',
            numTurns: event.numTurns,
            modelUsage: event.modelUsage,
            ...(event.error ? { summary: event.error } : {}),
          };
        } else if (event.type === 'run_state_changed') {
          if (['completed', 'cancelled', 'failed', 'orphaned'].includes(event.status)) {
            terminal = {
              globalSequence: after,
              tenantId: envelope.tenantId,
              sessionId: envelope.sessionId,
              runId: event.runId,
              status: event.status as AutomationTerminalEvent['status'],
              stateOnly: true,
              ...(event.reason ? { summary: event.reason } : {}),
            };
          } else if (!['pending', 'running', 'waiting_approval', 'waiting_user', 'waiting_hand'].includes(event.status)) {
            // A newly introduced/invalid status must fail closed. Advancing this cursor would
            // permanently discard a terminal transition that this projector does not understand.
            throw new Error(`unknown runtime run status at terminal cursor: ${String(event.status)}`);
          }
        }
        if (!terminal) {
          // Multiple projector instances may recover the same consumer concurrently. A slower
          // non-terminal page must never overwrite a newer terminal projection's cursor.
          await this.store.pool.query(
            `UPDATE ${this.store.tables.consumers}
                SET last_global_sequence=GREATEST(last_global_sequence,$2),updated_at=now()
              WHERE consumer_name=$1`,
            [this.consumerName, after],
          );
          continue;
        }
        const frozenTerminal = await this.progressEvidence(eventStore, terminal);
        await this.project(frozenTerminal);
        processed++;
      }
      if (!page.hasMore) break;
    }
    return processed;
  }

  start(eventStore: PgEventStore, options: { pollMs?: number; onError?: (error: unknown) => void } = {}): void {
    if (this.timer) return;
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try { await this.recover(eventStore); } catch (error) { options.onError?.(error); } finally { this.running = false; }
    };
    void tick();
    this.timer = setInterval(() => void tick(), options.pollMs ?? 10_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    while (this.running) await new Promise(resolve => setTimeout(resolve, 10));
  }
}
