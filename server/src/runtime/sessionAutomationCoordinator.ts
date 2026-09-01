import type { RuntimeScheduler } from './scheduler.js';
import type { SessionCatalog } from './sessionCatalog.js';
import type { ClaimedDispatch, PgSessionAutomationStore, SessionAutomationLifecycleAdapters } from './sessionAutomationStore.js';

export interface AutomationRunDispatcher {
  stage(input: { tenantId: string; sessionId: string; runId: string; prompt: string; metadata: Record<string, unknown> }): Promise<void>;
  activate(runId: string): Promise<void>;
}

/** Production adapter: create-only staged Run, then explicit activation after the automation execution row exists. */
export class RuntimeSchedulerAutomationDispatcher implements AutomationRunDispatcher {
  constructor(private readonly scheduler: RuntimeScheduler, private readonly sessions: SessionCatalog) {}

  async stage(input: { tenantId: string; sessionId: string; runId: string; prompt: string; metadata: Record<string, unknown> }): Promise<void> {
    const session = await this.sessions.get(input.sessionId);
    if (!session || session.tenantId !== input.tenantId) throw new Error('automation session identity unavailable');
    await this.scheduler.enqueueCreateOnly({
      runId: input.runId,
      sessionId: input.sessionId,
      tenantId: input.tenantId,
      userId: session.userId,
      submitterUserId: session.userId,
      model: session.modelRef,
      channel: session.channel ?? 'web',
      executionTarget: session.executionTarget,
      workspaceId: session.workspaceId ?? input.sessionId,
      sandboxScopeId: input.sessionId,
      idempotencyKey: `session-automation:${input.runId}`,
      metadata: {
        schedulerState: 'staged',
        cwd: session.cwd,
        transcriptPath: session.transcriptPath,
        ...(session.modelRef ? { modelRef: session.modelRef } : {}),
        ...(session.profileId ? { profileId: session.profileId } : {}),
        ...(session.profileVersionId ? { profileVersionId: session.profileVersionId } : {}),
        ...(session.profileConfigDigest ? { profileConfigDigest: session.profileConfigDigest } : {}),
        ...(session.orgAgentId ? { orgAgentId: session.orgAgentId } : {}),
        wakeMessage: {
          channel: 'web', chatId: input.sessionId, content: input.prompt,
          senderId: session.userId, senderName: session.username,
          metadata: { hiddenContinuation: true, sessionAutomation: true },
        },
        automationFence: input.metadata,
      },
    });
  }

  async activate(runId: string): Promise<void> { await this.scheduler.activateCreatedRun(runId); }

}

export class SessionAutomationCoordinator {
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(
    readonly store: PgSessionAutomationStore,
    readonly dispatcher: AutomationRunDispatcher,
    readonly options: { executionEnabled: () => boolean; cancelRun?: (runId:string,reason:string)=>Promise<void>; lifecycleAdapters?:SessionAutomationLifecycleAdapters; pollMs?: number; batchSize?: number; onError?: (error: unknown) => void },
  ) {}
  start(): void { if (this.timer) return; void this.tick(); this.timer = setInterval(() => void this.tick(), this.options.pollMs ?? 1_000); this.timer.unref(); }
  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); this.timer = undefined; while (this.running) await new Promise(r => setTimeout(r, 10)); }
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.store.recoverLeases();
      await this.processCancellations();
      await this.store.processLifecycleWork?.(this.options.lifecycleAdapters, this.options.batchSize ?? 25);
      // Reconciliation is maintenance, not execution: it must keep converging while the
      // execution kill switch is off. Individual stage and activate effects are gated below.
      await this.recoverStagedActivations();
      if (!this.options.executionEnabled()) return;
      await this.store.claimDue(this.options.batchSize ?? 25);
      if (!this.options.executionEnabled()) return;
      for (const item of await this.store.claimDispatch(this.options.batchSize ?? 10)) {
        if (!this.options.executionEnabled()) break;
        await this.dispatchOne(item);
      }
    } catch (error) { this.options.onError?.(error); }
    finally { this.running = false; }
  }
  private async processCancellations(): Promise<void> {for(const item of await this.store.claimCancellations(this.options.batchSize??10)){try{if(!this.options.cancelRun)throw new Error('automation cancel adapter unavailable');await this.options.cancelRun(item.runId,item.reason);await this.store.completeCancellation(item);}catch(error){await this.store.failCancellation(item,error);}}}
  private async recoverStagedActivations(): Promise<void> {
    for (const attempt of await this.store.listRecoverablePreparedDispatches()) {
      const run = await this.store.pool.query(
        `SELECT r.status,r.metadata,
                EXISTS(
                  SELECT 1 FROM ${this.store.tables.executions} e
                  JOIN ${this.store.tables.outbox} o
                    ON o.tenant_id=e.tenant_id AND o.session_id=e.session_id AND o.outbox_id=e.outbox_id
                  JOIN ${this.store.tables.automations} a
                    ON a.tenant_id=e.tenant_id AND a.session_id=e.session_id AND a.automation_id=e.automation_id
                 WHERE e.tenant_id=$1 AND e.session_id=$2 AND e.execution_id=$4 AND e.run_id=$3
                   AND o.state='dispatched'
                   AND ((e.state='running' AND a.active_run_id=e.run_id) OR e.state='terminal')
                ) AS admitted
           FROM ${this.store.runsTable} r
          WHERE r.tenant_id=$1 AND r.session_id=$2 AND r.run_id=$3`,
        [attempt.tenantId, attempt.sessionId, attempt.runId, attempt.outboxId],
      );
      const fence = run.rows[0]?.metadata?.automationFence as { executionId?: string } | undefined;
      if (attempt.state === 'dispatched') {
        // A stage result may be known while the automation outbox is still waiting to reclaim.
        // Never activate that Run until markDispatched durably owns the execution and active slot.
        if (run.rows[0]?.admitted === true && fence?.executionId === attempt.outboxId) {
          if (run.rows[0].status === 'pending') {
            if (!this.options.executionEnabled()) continue;
            await this.dispatcher.activate(attempt.runId);
          }
          await this.store.transitionPreparedDispatch(attempt.outboxId, 'dispatched', 'completed');
        }
        continue;
      }
      if (attempt.state === 'result_unknown' || attempt.state === 'reconcile') {
        if (run.rows[0] && fence?.executionId === attempt.outboxId) {
          if (attempt.state === 'result_unknown') {
            await this.store.transitionPreparedDispatch(attempt.outboxId, 'result_unknown', 'reconcile');
          }
          await this.store.transitionPreparedDispatch(attempt.outboxId, 'reconcile', 'dispatched');
        }
        continue;
      }
      if (!run.rows[0]) {
        const stage = attempt.requestPayload.stage as Parameters<AutomationRunDispatcher['stage']>[0] | undefined;
        if (!stage) {
          await this.store.transitionPreparedDispatch(
            attempt.outboxId, 'prepared', 'result_unknown', 'missing_recovery_payload',
          );
          continue;
        }
        if (!this.options.executionEnabled()) continue;
        await this.dispatcher.stage(stage);
      } else if (fence?.executionId !== attempt.outboxId) {
        await this.store.transitionPreparedDispatch(
          attempt.outboxId, 'prepared', 'result_unknown', 'staged_run_lineage_mismatch',
        );
      }
      // Keep the attempt prepared until dispatchOne reclaims the outbox. Its deterministic
      // create-only stage will then resume the same fenced transition sequence.
    }
  }
  private async dispatchOne(item: ClaimedDispatch): Promise<void> {
    let dispatchCommitted = false;
    try {
      const snapshot = await this.store.get(item.tenantId, item.sessionId, item.automationId);
      if (!snapshot || snapshot.status !== 'active' || snapshot.activeRunId || snapshot.generation !== item.generation || snapshot.incarnationId !== item.incarnationId){await this.store.supersedeDispatch(item);return;}
      const prompt = snapshot.spec.kind === 'goal' ? `Continue working toward this completion condition:\n${snapshot.spec.condition}` : snapshot.spec.prompt!;
      const fence = {
        rootAutomationId: item.automationId,
        automationId: item.automationId,
        automationGeneration: item.generation,
        generation: item.generation,
        automationSpecVersion: item.specVersion,
        specVersion: item.specVersion,
        incarnationId: item.incarnationId,
        automationTriggerKey: item.triggerKey,
        executionId: item.outboxId,
        runId: item.targetRunId,
        rootSessionId: item.sessionId,
        rootRunId: item.targetRunId,
      };
      const stageInput = { tenantId: item.tenantId, sessionId: item.sessionId, runId: item.targetRunId, prompt, metadata: fence };
      if (!this.options.executionEnabled()) return;
      await this.store.prepareDispatch(item,{stage:stageInput});
      if (!this.options.executionEnabled()) return;
      try {
        await this.dispatcher.stage(stageInput);
        await this.store.transitionPreparedDispatch(item.outboxId,'prepared','dispatched');
      } catch (error) {
        await this.store.transitionPreparedDispatch(item.outboxId,'prepared','result_unknown',error instanceof Error?error.message:String(error));
        throw error;
      }
      // If the switch changed after create-only staging, preserve that durable staged Run.
      // A later enabled tick will reclaim the outbox and idempotently continue admission.
      if (!this.options.executionEnabled()) return;
      try{await this.store.markDispatched(item);dispatchCommitted=true;}catch(error){await this.store.supersedeDispatch(item,true);throw error;}
      if (!this.options.executionEnabled()) return;
      try {
        await this.dispatcher.activate(item.targetRunId);
      } catch (error) {
        // The durable dispatch and active slot are already committed. Leave both intact so
        // staged recovery can retry activation without making the outbox claimable.
        this.options.onError?.(error);
        return;
      }
      await this.store.transitionPreparedDispatch(item.outboxId,'dispatched','completed');
      const dispatched=await this.store.get(item.tenantId,item.sessionId,item.automationId);if(dispatched)this.store.publish(dispatched,'automation_execution_changed');
    } catch (error) {
      if (dispatchCommitted) { this.options.onError?.(error); return; }
      if(error instanceof Error&&error.message==='dispatch fence lost')return;
      const unknown = await this.store.pool.query(
        `SELECT 1 FROM ${this.store.tables.preparedDispatchAttempts}
          WHERE outbox_id=$1 AND state IN ('result_unknown','reconcile')`,
        [item.outboxId],
      );
      if(unknown.rowCount)return;
      await this.store.failDispatch(item, error);
    }
  }
}
