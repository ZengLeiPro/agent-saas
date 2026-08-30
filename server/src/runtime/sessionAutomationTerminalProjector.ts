import { randomUUID } from 'node:crypto';
import type { PgEventStore } from './pgEventStore.js';
import type { SdkResultModelUsage } from '../agent/types.js';
import type { PlatformEvent } from './types.js';
import { extractRunProgressEvidence, reduceNoProgress } from './sessionAutomationBudgetProgress.js';
import type { PgSessionAutomationStore } from './sessionAutomationStore.js';

export interface AutomationTerminalEvent {
  globalSequence: number;
  tenantId: string;
  sessionId: string;
  runId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted';
  summary?: string;
  evidenceRefs?: string[];
  progressFingerprint?: string;
  numTurns?: number;
  modelUsage?: Record<string, SdkResultModelUsage>;
}

function totalTokens(modelUsage?: Record<string, SdkResultModelUsage>): number {
  return Object.values(modelUsage ?? {}).reduce((total, usage) => total
    + Number(usage.inputTokens ?? 0)
    + Number(usage.outputTokens ?? 0)
    + Number(usage.reasoningTokens ?? 0), 0);
}

export class SessionAutomationTerminalProjector {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    readonly store: PgSessionAutomationStore,
    readonly consumerName = 'session-automation-terminal-v2',
    readonly noProgressThreshold = 3,
  ) {}

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
        `SELECT e.*,a.status,a.mode,a.active_run_id,a.no_progress_count,a.last_progress_fingerprint,
                a.incarnation_id AS current_incarnation,a.generation AS current_generation,
                a.control_version AS current_control_version,s.spec
           FROM ${this.store.tables.executions} e
           JOIN ${this.store.tables.automations} a USING(automation_id)
           JOIN ${this.store.tables.specs} s ON s.automation_id=a.automation_id AND s.spec_version=a.spec_version
          WHERE e.tenant_id=$1 AND e.session_id=$2 AND e.run_id=$3
          FOR UPDATE OF e,a`,
        [event.tenantId, event.sessionId, event.runId],
      );
      const row = execution.rows[0];
      if (row) {
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
          `UPDATE ${this.store.tables.wakeups} SET state='consumed'
            WHERE wakeup_id=(SELECT wakeup_id FROM ${this.store.tables.outbox} WHERE outbox_id=$1)`,
          [row.outbox_id],
        );
        await this.store.recordUsage({
          tenantId: event.tenantId,
          sessionId: event.sessionId,
          automationId: row.automation_id,
          executionId: row.execution_id,
          sourceKey: `run:${event.runId}`,
          sourceKind: 'automation_run',
          turns: event.numTurns ?? 0,
          tokens: totalTokens(event.modelUsage),
        }, client);

        const ownsActiveRun = row.active_run_id === event.runId;
        const fenced = row.incarnation_id === row.current_incarnation
          && Number(row.generation) === Number(row.current_generation);
        if (ownsActiveRun && row.status === 'cancelling') {
          await client.query(
            `UPDATE ${this.store.tables.automations}
                SET status='cancelled',phase='terminal',active_run_id=NULL,next_wakeup_at=NULL,
                    projection_version=projection_version+1,updated_at=now()
              WHERE tenant_id=$1 AND automation_id=$2 AND active_run_id=$3`,
            [event.tenantId, row.automation_id, event.runId],
          );
          await client.query(
            `UPDATE ${this.store.tables.cancellations}
                SET state='completed',lease_token=NULL,lease_expires_at=NULL,updated_at=now()
              WHERE tenant_id=$1 AND run_id=$2`,
            [event.tenantId, event.runId],
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
          } else if (row.mode === 'fixed') {
            const interval = Number(row.spec.intervalMs);
            const slot = Math.floor(Date.now() / interval) + 1;
            await this.store.scheduleTx(client, {
              tenantId: event.tenantId,
              sessionId: event.sessionId,
              automationId: row.automation_id,
              incarnationId: row.current_incarnation,
              generation: Number(row.current_generation),
              specVersion: Number(row.spec_version),
              continuationEpoch: slot,
              triggerKey: `fixed:${row.automation_id}:g${row.generation}:slot${slot}`,
              dueAt: new Date(slot * interval),
              payload: { sourceRunId: event.runId },
            });
            await client.query(
              `UPDATE ${this.store.tables.automations}
                  SET active_run_id=NULL,no_progress_count=$3,last_progress_fingerprint=$4
                WHERE tenant_id=$1 AND automation_id=$2 AND active_run_id=$5`,
              [event.tenantId, row.automation_id, noProgress.count, fingerprint, event.runId],
            );
          } else {
            await client.query(
              `UPDATE ${this.store.tables.automations}
                  SET phase=CASE WHEN mode='goal' THEN 'evaluating' ELSE 'idle' END,
                      active_run_id=NULL,no_progress_count=$3,last_progress_fingerprint=$4
                WHERE tenant_id=$1 AND automation_id=$2 AND active_run_id=$5`,
              [event.tenantId, row.automation_id, noProgress.count, fingerprint, event.runId],
            );
          }

          if (row.mode === 'goal') {
            const evidence = {
              summary: event.summary ?? '',
              evidenceRefs: event.evidenceRefs ?? [],
              hardGates: { runTerminal: true, noPendingInteraction: false, noActiveResources: false, budgetValid: false },
            };
            await client.query(
              `INSERT INTO ${this.store.tables.evaluations}
                (evaluation_id,tenant_id,session_id,automation_id,execution_id,incarnation_id,generation,spec_version,decision_epoch,evidence)
               SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
               WHERE NOT EXISTS (SELECT 1 FROM ${this.store.tables.evaluations} WHERE execution_id=$5)
               ON CONFLICT(tenant_id,automation_id,generation,decision_epoch) DO NOTHING`,
              [randomUUID(), event.tenantId, event.sessionId, row.automation_id, row.execution_id,
                row.current_incarnation, row.current_generation, row.spec_version,
                event.globalSequence, JSON.stringify(evidence)],
            );
          }
        }
        const next=await this.store.getLocked(client,event.tenantId,event.sessionId,row.automation_id);
        if(next)await this.store.event(client,next,'automation_execution_changed',{runId:event.runId,status:event.status,snapshot:next});
      }

      await client.query(
        `UPDATE ${this.store.tables.consumers}
            SET last_global_sequence=$2,updated_at=now() WHERE consumer_name=$1`,
        [this.consumerName, event.globalSequence],
      );
      return true;
    });
  }

  private async publishRunState(event:AutomationTerminalEvent):Promise<void>{const result=await this.store.pool.query(`SELECT automation_id FROM ${this.store.tables.executions} WHERE tenant_id=$1 AND session_id=$2 AND run_id=$3`,[event.tenantId,event.sessionId,event.runId]);const automationId=result.rows[0]?.automation_id;if(!automationId)return;const snapshot=await this.store.get(event.tenantId,event.sessionId,String(automationId));if(snapshot)this.store.publish(snapshot,'automation_execution_changed');}

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
        } else if (event.type === 'run_state_changed' && ['cancelled', 'failed'].includes(event.status)) {
          terminal = {
            globalSequence: after,
            tenantId: envelope.tenantId,
            sessionId: envelope.sessionId,
            runId: event.runId,
            status: event.status === 'cancelled' ? 'cancelled' : 'failed',
            ...(event.reason ? { summary: event.reason } : {}),
          };
        }
        if (!terminal) {
          await this.store.pool.query(
            `UPDATE ${this.store.tables.consumers} SET last_global_sequence=$2,updated_at=now() WHERE consumer_name=$1`,
            [this.consumerName, after],
          );
          continue;
        }
        try {
          const frozenTerminal = await this.progressEvidence(eventStore, terminal);
          await this.project(frozenTerminal);
          await this.publishRunState(frozenTerminal);
        } catch (error) { await this.quarantine(after, event, error); }
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
