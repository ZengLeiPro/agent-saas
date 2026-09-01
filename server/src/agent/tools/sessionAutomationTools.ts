import { z } from 'zod';
import type { ScheduleWakeupInput, UpdateGoalInput } from '@agent/shared';
import type { AuthorizedToolCall, ToolCallContext, ToolDescriptor, ToolProvider, ToolResult } from '../toolRuntime.js';
import type { PgSessionAutomationStore } from '../../runtime/sessionAutomationStore.js';
import type { SessionAutomationEvaluator } from '../../runtime/sessionAutomationEvaluator.js';
import type { SessionAutomationExecutionFlagSource } from '../../runtime/sessionAutomationFlags.js';

export interface SessionAutomationFence {
  automationId: string;
  incarnationId: string;
  generation: number;
  specVersion: number;
  executionId: string;
}

const scheduleSchema = z.object({
  action: z.enum(['schedule', 'stop']),
  delayMs: z.number().int().optional(),
  reason: z.string().max(1000).optional(),
});
const goalSchema = z.object({
  action: z.enum(['continue', 'blocked', 'complete_candidate']),
  summary: z.string().min(1).max(8000),
  evidenceRefs: z.array(z.string().min(1).max(1000)).max(50).optional(),
});

export const scheduleWakeupToolDescriptor: ToolDescriptor = {
  id: 'ScheduleWakeup', name: 'ScheduleWakeup', displayName: 'Schedule wakeup',
  description: 'For this automation execution only: schedule the next adaptive continuation or stop it. The host supplies the immutable automation fence.',
  schema: scheduleSchema, risk: 'safe', approvalMode: 'never', auditCategory: 'session_automation', category: 'session', label: '安排续跑',
};
export const updateGoalToolDescriptor: ToolDescriptor = {
  id: 'UpdateGoal', name: 'UpdateGoal', displayName: 'Update goal',
  description: 'For this goal automation execution only: continue, report blocked, or nominate a completion candidate with evidence. A separate evaluator decides completion.',
  schema: goalSchema, risk: 'safe', approvalMode: 'never', auditCategory: 'session_automation', category: 'session', label: '更新目标',
};

const executionDisabled = { accepted: false, reason: 'execution_disabled' } as const;

export class SessionAutomationTools {
  constructor(
    readonly store: PgSessionAutomationStore,
    readonly flagSource: SessionAutomationExecutionFlagSource,
    readonly evaluator?: SessionAutomationEvaluator,
  ) {}

  async scheduleWakeup(input: ScheduleWakeupInput & {tenantId: string; sessionId: string}): Promise<{accepted: boolean; reason?: string}> {
    if (!this.flagSource.executionEnabled()) return executionDisabled;
    return this.store.tx(async c => {
      const current = await this.store.getLocked(c, input.tenantId, input.sessionId, input.automationId).catch(() => undefined);
      if (!current) return { accepted: false, reason: 'not_found' };
      if (current.spec.kind !== 'loop' || current.spec.mode !== 'adaptive') return { accepted: false, reason: 'not_adaptive' };
      if (current.incarnationId !== input.incarnationId || current.generation !== input.generation
        || current.specVersion !== input.specVersion || current.activeRunId !== input.runId) return { accepted: false, reason: 'stale_fence' };
      if (!this.flagSource.executionEnabled()) return executionDisabled;
      if (input.action === 'stop') {
        await this.store.beginTerminalDrainLocked(c, current, 'completed', input.reason ?? 'adaptive_stop');
        return { accepted: true };
      }
      if (!input.delayMs || input.delayMs < 60_000 || input.delayMs > 86_400_000) return { accepted: false, reason: 'delay_out_of_range' };
      const epoch = Date.now();
      await c.query(`UPDATE ${this.store.tables.wakeups} SET state='superseded' WHERE tenant_id=$1 AND automation_id=$2 AND state IN ('pending','claimed')`, [current.tenantId, current.automationId]);
      await c.query(`UPDATE ${this.store.tables.automations} SET continuation_epoch=$3 WHERE tenant_id=$1 AND automation_id=$2`, [current.tenantId, current.automationId, epoch]);
      await this.store.scheduleTx(c, {
        tenantId: current.tenantId, sessionId: current.sessionId, automationId: current.automationId,
        incarnationId: current.incarnationId, generation: current.generation, specVersion: current.specVersion,
        continuationEpoch: epoch, triggerKey: `adaptive:${current.automationId}:g${current.generation}:e${epoch}:from:${input.runId}`,
        dueAt: new Date(Date.now() + input.delayMs), payload: { reason: input.reason },
      });
      return { accepted: true };
    });
  }

  async updateGoal(input: UpdateGoalInput & {tenantId: string; sessionId: string; executionId: string}): Promise<{accepted: boolean; reason?: string}> {
    if (!this.flagSource.executionEnabled()) return executionDisabled;
    const current = await this.store.get(input.tenantId, input.sessionId, input.automationId);
    if (!current || current.spec.kind !== 'goal') return { accepted: false, reason: 'not_found' };
    if (current.incarnationId !== input.incarnationId || current.generation !== input.generation
      || current.specVersion !== input.specVersion || current.activeRunId !== input.runId) return { accepted: false, reason: 'stale_fence' };
    if (!this.flagSource.executionEnabled()) return executionDisabled;
    if (input.action === 'complete_candidate') {
      if (!this.evaluator) return { accepted: false, reason: 'evaluator_unavailable' };
      const result = await this.evaluator.nominate({ ...input, executionId: input.executionId, evidenceRefs: input.evidenceRefs ?? [] });
      return { accepted: result.queued, reason: result.reason };
    }
    if (input.action === 'blocked') {
      const accepted = await this.store.tx(async c => {
        const locked = await this.store.getLocked(c, input.tenantId, input.sessionId, input.automationId);
        if (!locked || locked.incarnationId !== input.incarnationId || locked.generation !== input.generation
          || locked.specVersion !== input.specVersion || locked.activeRunId !== input.runId) return false;
        if (!this.flagSource.executionEnabled()) return false;
        await this.store.beginTerminalDrainLocked(c, locked, 'blocked', input.summary);
        return true;
      });
      if (accepted) return { accepted: true };
      return this.flagSource.executionEnabled() ? { accepted: false, reason: 'stale_fence' } : executionDisabled;
    }
    const accepted = await this.store.tx(async c => {
      const locked = await this.store.getLocked(c, input.tenantId, input.sessionId, input.automationId);
      if (!locked || locked.spec.kind !== 'goal'
        || locked.tenantId !== input.tenantId || locked.sessionId !== input.sessionId || locked.automationId !== input.automationId
        || locked.incarnationId !== input.incarnationId || locked.generation !== input.generation
        || locked.specVersion !== input.specVersion || locked.activeRunId !== input.runId
        || !(await this.store.hasLockedExecutionLineage(c, locked, input.executionId, input.runId))) return false;
      if (!this.flagSource.executionEnabled()) return false;
      const epoch = Date.now();
      await c.query(`UPDATE ${this.store.tables.wakeups} SET state='superseded' WHERE tenant_id=$1 AND automation_id=$2 AND state IN ('pending','claimed')`, [locked.tenantId, locked.automationId]);
      await c.query(`UPDATE ${this.store.tables.automations} SET continuation_epoch=$3 WHERE tenant_id=$1 AND automation_id=$2`, [locked.tenantId, locked.automationId, epoch]);
      await this.store.scheduleTx(c, {
        tenantId: locked.tenantId, sessionId: locked.sessionId, automationId: locked.automationId,
        incarnationId: locked.incarnationId, generation: locked.generation, specVersion: locked.specVersion,
        continuationEpoch: epoch, triggerKey: `goal:${locked.automationId}:g${locked.generation}:e${epoch}:from:${input.runId}`,
        dueAt: new Date(), payload: { summary: input.summary },
      });
      return true;
    });
    if (accepted) return { accepted: true };
    return this.flagSource.executionEnabled() ? { accepted: false, reason: 'stale_fence' } : executionDisabled;
  }
}

export class SessionAutomationToolProvider implements ToolProvider {
  constructor(
    readonly tools: SessionAutomationTools,
    readonly flagSource: SessionAutomationExecutionFlagSource,
  ) {}

  list(context?: ToolCallContext): ToolDescriptor[] {
    const fence = context?.automationFence;
    if (!fence || context?.runId !== fence.runId) return [];
    return [scheduleWakeupToolDescriptor, updateGoalToolDescriptor];
  }

  async invoke<T>(call: AuthorizedToolCall<T>, context: ToolCallContext): Promise<ToolResult | undefined> {
    const fence = context.automationFence;
    if (!fence || !context.runId || !context.sessionId) return undefined;
    if (call.toolId !== 'ScheduleWakeup' && call.toolId !== 'UpdateGoal') return undefined;
    if (!this.flagSource.executionEnabled()) return { content: JSON.stringify(executionDisabled) };
    const tenantId = context.channelContext.sessionOwner?.tenantId ?? context.channelContext.user?.tenantId;
    if (!tenantId) return { content: JSON.stringify({ accepted: false, reason: 'missing_tenant' }) };
    const result = call.toolId === 'ScheduleWakeup'
      ? await this.tools.scheduleWakeup({ ...scheduleSchema.parse(call.input), ...fence, tenantId, sessionId: context.sessionId, runId: context.runId })
      : await this.tools.updateGoal({ ...goalSchema.parse(call.input), ...fence, tenantId, sessionId: context.sessionId, runId: context.runId });
    return { content: JSON.stringify(result) };
  }
}
