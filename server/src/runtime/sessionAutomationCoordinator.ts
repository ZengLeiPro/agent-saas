import type { RuntimeScheduler } from './scheduler.js';
import type { SessionCatalog } from './sessionCatalog.js';
import type { ClaimedDispatch, PgSessionAutomationStore } from './sessionAutomationStore.js';

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
    readonly options: { executionEnabled: () => boolean; pollMs?: number; batchSize?: number; onError?: (error: unknown) => void } = { executionEnabled: () => false },
  ) {}
  start(): void { if (this.timer) return; void this.tick(); this.timer = setInterval(() => void this.tick(), this.options.pollMs ?? 1_000); this.timer.unref(); }
  async stop(): Promise<void> { if (this.timer) clearInterval(this.timer); this.timer = undefined; while (this.running) await new Promise(r => setTimeout(r, 10)); }
  async tick(): Promise<void> {
    if (this.running || !this.options.executionEnabled()) return;
    this.running = true;
    try {
      await this.store.recoverLeases();
      await this.recoverStagedActivations();
      await this.store.claimDue(this.options.batchSize ?? 25);
      for (const item of await this.store.claimDispatch(this.options.batchSize ?? 10)) await this.dispatchOne(item);
    } catch (error) { this.options.onError?.(error); }
    finally { this.running = false; }
  }
  private async recoverStagedActivations(): Promise<void> {
    const rows = await this.store.pool.query(`SELECT o.target_run_id FROM ${this.store.tables.outbox} o JOIN ${this.store.runsTable} r ON r.tenant_id=o.tenant_id AND r.session_id=o.session_id AND r.run_id=o.target_run_id WHERE o.state='dispatched' AND r.status='pending' AND r.metadata->>'schedulerState'='staged' ORDER BY o.created_at LIMIT 50`);
    for (const row of rows.rows) await this.dispatcher.activate(String(row.target_run_id));
  }
  private async dispatchOne(item: ClaimedDispatch): Promise<void> {
    try {
      const snapshot = await this.store.get(item.tenantId, item.sessionId, item.automationId);
      if (!snapshot || snapshot.status !== 'active' || snapshot.generation !== item.generation || snapshot.incarnationId !== item.incarnationId) return;
      const prompt = snapshot.spec.kind === 'goal' ? `Continue working toward this completion condition:\n${snapshot.spec.condition}` : snapshot.spec.prompt!;
      const fence = { rootAutomationId: item.automationId, automationId: item.automationId, automationGeneration: item.generation, generation: item.generation, automationSpecVersion: item.specVersion, specVersion: item.specVersion, incarnationId: item.incarnationId, automationTriggerKey: item.triggerKey, executionId: item.outboxId, runId: item.targetRunId };
      await this.dispatcher.stage({ tenantId: item.tenantId, sessionId: item.sessionId, runId: item.targetRunId, prompt, metadata: fence });
      await this.store.markDispatched(item);
      await this.dispatcher.activate(item.targetRunId);
    } catch (error) {
      await this.store.failDispatch(item, error);
    }
  }
}
