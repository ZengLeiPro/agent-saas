/**
 * L2 记忆审查引擎：durable global cursor 扫描 run 边界；会话静默期到达后，
 * 启动隐藏 Run，从父会话完整 Context Projection 重放；文件工具先写进程内草稿，
 * Run 成功后才在短时用户锁内做冲突校验并提交真实 Markdown。
 *
 * 正确性边界：durable cursor / state lease / idempotency ledger / active-run gate / 30 分钟
 * debounce / per-user 进程锁与提交阶段 PG advisory lock。Prompt Cache 由父会话同模型、同
 * Profile、同 System Prompt、同工具 descriptor 的内容指纹自然复用；不使用
 * previous_response_id。
 */

import { createHash, randomUUID } from 'node:crypto';

import type { AgentRunDispatch } from '../../agent/types.js';
import type { ChannelContext, InboundMessage, OutboundEvent } from '../../types/index.js';
import { resolveUserCwd } from '../../workspace/resolver.js';
import { releaseMemoryMaintenance, tryAcquireMemoryMaintenance } from '../maintenanceLock.js';
import {
  commitMemoryConsolidationDraft,
  discardMemoryConsolidationDraft,
  inspectMemoryConsolidationDraft,
  recoverMemoryConsolidationPreparedCommit,
  rollbackMemoryConsolidationPreparedCommit,
  MemoryConsolidationDraftConflictError,
} from './draft.js';
import { buildConsolidationPrompt, MEMORY_CONSOLIDATION_PROMPT_VERSION } from './prompt.js';
import {
  PgMemoryConsolidationStore,
  type MemoryConsolidationCommitFence,
  type MemoryConsolidationCommitLock,
} from './store.js';
import {
  CONSOLIDATION_RETRY_BACKOFF_MINUTES,
  type ConsolidationState,
  type MemoryConsolidationResolvedConfig,
} from './types.js';

interface EventStoreForConsolidation {
  listGlobalPage(options: {
    afterGlobalSequence: number;
    types: ReadonlyArray<string>;
    limit?: number;
  }): Promise<{
    events: Array<{
      globalSequence: number;
      sessionSequence: number;
      tenantId: string;
      sessionId: string;
      event: Record<string, unknown> & { type: string; id: string };
    }>;
    hasMore: boolean;
  }>;
  listSessionRange(sessionId: string, options: {
    fromExclusive: number;
    toInclusive: number;
    excludeTypes?: ReadonlyArray<string>;
    limit?: number;
  }): Promise<Array<{
    sessionSequence: number;
    event: Record<string, unknown> & { type: string; id: string };
  }>>;
}

interface ConsolidationProjection {
  sessionId: string;
  tenantId: string;
  userId?: string;
  username?: string;
  channel?: string;
  kind: 'user' | 'subagent';
  runtimeStatus?: string;
  model?: string;
  workspaceId?: string;
  metaJson: {
    cronSystemKind?: string;
    cronJobName?: string;
    kind?: string;
    memoryPolicyVersion?: string;
    sessionSource?: string;
    memoryAutomationEligible?: boolean;
    profileBindingKey?: string;
  };
}

interface ProjectionStoreForConsolidation {
  get(sessionId: string, options?: { includeDeleted?: boolean }): Promise<ConsolidationProjection | null>;
}

export interface MemoryConsolidationEngineOptions {
  store: PgMemoryConsolidationStore;
  eventStore: EventStoreForConsolidation;
  projectionStore: ProjectionStoreForConsolidation;
  userStore: {
    findById(id: string): {
      id: string;
      username: string;
      role: string;
      tenantId?: string;
      disabled?: boolean;
    } | undefined;
  };
  isTenantEnabled(tenantId: string): boolean;
  dispatch: AgentRunDispatch;
  agentCwd: string;
  getConfig(): MemoryConsolidationResolvedConfig;
  logger?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
  };
}

const CONSUMER_NAME = 'memory-consolidation-v1';
const CONSOLIDATION_CHAT_PREFIX = 'memory-consolidate-';
/** 新会话 projection 正常应很快出现；超过一小时仍缺失视为 poison event。 */
export const MISSING_PROJECTION_GRACE_MS = 60 * 60_000;
const MISSING_PROJECTION_WARN_INTERVAL_MS = 5 * 60_000;
const MAX_EVENT_FUTURE_SKEW_MS = 5 * 60_000;
const DRAFT_CLEANUP_WAIT_MS = 5_000;
const EXCLUDED_CHANNELS = new Set(['cron']);

function isEligibleProjection(projection: ConsolidationProjection, sessionId: string): boolean {
  const meta = projection.metaJson ?? {};
  return projection.kind === 'user'
    && meta.cronSystemKind === undefined
    && meta.memoryPolicyVersion === 'v2'
    && meta.profileBindingKey !== 'memory_poll'
    && meta.profileBindingKey !== 'memory_consolidate'
    && meta.sessionSource !== 'taskboard_execution'
    && meta.sessionSource !== 'memory_consolidation'
    && meta.memoryAutomationEligible !== false
    && (projection.channel === undefined || !EXCLUDED_CHANNELS.has(projection.channel))
    && !sessionId.startsWith('memory-maint-')
    && !sessionId.startsWith(CONSOLIDATION_CHAT_PREFIX)
    && !sessionId.startsWith('taskboard-')
    && Boolean(projection.userId);
}

export class MemoryConsolidationEngine {
  private scanTimer: ReturnType<typeof setInterval> | undefined;
  private workTimer: ReturnType<typeof setInterval> | undefined;
  private scanning = false;
  private working = false;
  private stopped = true;
  private readonly missingProjectionWarnedAt = new Map<number, number>();
  private readonly workerId = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;

  constructor(private readonly options: MemoryConsolidationEngineOptions) {}

  async start(): Promise<void> {
    const config = this.options.getConfig();
    await this.options.store.init();
    if (!config.enabled) {
      this.stopped = true;
      this.options.logger?.info('MemoryConsolidationEngine disabled by global config');
      return;
    }
    // 旧版本可能留下 throttled，或因普通运行失败耗尽重试而粘住 blocked；
    // 启动时一次性恢复，worker 随后会重新执行完整资格检查。
    await Promise.all([
      this.options.store.reviveThrottled(),
      this.options.store.reviveLegacyBlocked(),
    ]);
    this.stopped = false;
    this.scanTimer = setInterval(() => { void this.scanOnce(); }, config.scanIntervalMs);
    this.scanTimer.unref?.();
    this.workTimer = setInterval(() => { void this.workOnce(); }, Math.max(config.scanIntervalMs, 5_000));
    this.workTimer.unref?.();
    void this.scanOnce();
    this.options.logger?.info(`MemoryConsolidationEngine started (${this.workerId})`);
  }

  stop(): void {
    this.stopped = true;
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.workTimer) clearInterval(this.workTimer);
    this.scanTimer = this.workTimer = undefined;
  }

  /** NOTIFY 只做低延迟唤醒；正确性仍来自 durable cursor。 */
  wake(): void {
    void this.scanOnce();
    void this.workOnce();
  }

  private async scanOnce(): Promise<void> {
    if (this.stopped) return;
    if (this.scanning) {
      while (this.scanning && !this.stopped) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return;
    }
    this.scanning = true;
    try {
      const config = this.options.getConfig();
      if (!config.enabled) return;
      for (;;) {
        const cursor = await this.options.store.getConsumerCursor(CONSUMER_NAME);
        const page = await this.options.eventStore.listGlobalPage({
          afterGlobalSequence: cursor,
          types: ['run_started', 'run_finished'],
          limit: config.scanBatchSize,
        });
        if (page.events.length === 0) return;

        let lastApplied = cursor;
        for (const envelope of page.events) {
          if (this.stopped || !this.options.getConfig().enabled) return;
          const ok = await this.applyEnvelope(envelope, config);
          if (this.stopped || !this.options.getConfig().enabled) return;
          if (!ok) {
            if (lastApplied > cursor) {
              await this.options.store.advanceConsumerCursor(CONSUMER_NAME, lastApplied);
            }
            return;
          }
          lastApplied = envelope.globalSequence;
        }
        if (this.stopped || !this.options.getConfig().enabled) return;
        await this.options.store.advanceConsumerCursor(CONSUMER_NAME, lastApplied);
        if (!page.hasMore) return;
      }
    } catch (err) {
      this.options.logger?.warn(`consolidation scan failed: ${message(err)}`);
    } finally {
      this.scanning = false;
    }
  }

  /** false 表示 projection 尚在宽限期内缺失，consumer cursor 必须停住。 */
  private async applyEnvelope(
    envelope: Awaited<ReturnType<EventStoreForConsolidation['listGlobalPage']>>['events'][number],
    config: MemoryConsolidationResolvedConfig,
  ): Promise<boolean> {
    const event = envelope.event;
    if (!this.options.isTenantEnabled(envelope.tenantId)) return true;

    const projection = await this.options.projectionStore.get(envelope.sessionId, { includeDeleted: true });
    if (!projection) {
      const rawTimestamp = typeof event.timestamp === 'string' ? event.timestamp : undefined;
      const eventAtMs = rawTimestamp ? Date.parse(rawTimestamp) : Number.NaN;
      const now = Date.now();
      const tooFarInFuture = Number.isFinite(eventAtMs) && eventAtMs - now > MAX_EVENT_FUTURE_SKEW_MS;
      const withinGrace = Number.isFinite(eventAtMs)
        && !tooFarInFuture
        && now - eventAtMs < MISSING_PROJECTION_GRACE_MS;
      if (withinGrace) {
        const lastWarnedAt = this.missingProjectionWarnedAt.get(envelope.globalSequence) ?? 0;
        if (now - lastWarnedAt >= MISSING_PROJECTION_WARN_INTERVAL_MS) {
          this.missingProjectionWarnedAt.set(envelope.globalSequence, now);
          this.options.logger?.warn(
            `consolidation scanner: session projection missing for ${envelope.sessionId} `
            + `(global_seq=${envelope.globalSequence}), holding cursor within grace window`,
          );
        }
        return false;
      }

      const reason = !Number.isFinite(eventAtMs)
        ? 'projection_missing_invalid_timestamp'
        : tooFarInFuture
          ? 'projection_missing_future_timestamp'
          : 'projection_missing_after_grace';
      await this.options.store.quarantineEnvelopeAndAdvanceCursor({
        consumerName: CONSUMER_NAME,
        globalSequence: envelope.globalSequence,
        tenantId: envelope.tenantId,
        sessionId: envelope.sessionId,
        eventType: event.type,
        ...(rawTimestamp && Number.isFinite(eventAtMs) ? { eventTimestamp: rawTimestamp } : {}),
        reason,
      });
      this.missingProjectionWarnedAt.delete(envelope.globalSequence);
      this.options.logger?.warn(
        `consolidation scanner: quarantined event with missing projection session=${envelope.sessionId} `
        + `global_seq=${envelope.globalSequence} reason=${reason}`,
      );
      return true;
    }
    this.missingProjectionWarnedAt.delete(envelope.globalSequence);

    if (!isEligibleProjection(projection, envelope.sessionId)) return true;
    const user = this.options.userStore.findById(projection.userId!);
    if (!user || user.disabled) return true;

    const base = {
      tenantId: envelope.tenantId,
      userId: projection.userId!,
      workspaceId: projection.workspaceId ?? projection.username ?? projection.userId!,
      sessionId: envelope.sessionId,
    };
    const runId = typeof event.runId === 'string' ? event.runId : 'unknown-run';
    const at = typeof event.timestamp === 'string' ? event.timestamp : new Date().toISOString();

    if (event.type === 'run_started') {
      await this.options.store.applyRunStarted({ ...base, runId, at, globalSequence: envelope.globalSequence });
      return true;
    }
    if (event.type === 'run_finished') {
      const subtype = typeof event.subtype === 'string' ? event.subtype : 'success';
      const eligible = subtype === 'success'
        || (subtype === 'interrupted' && config.includeInterrupted);
      await this.options.store.applyRunFinished({
        ...base,
        runId,
        sessionSequence: envelope.sessionSequence,
        globalSequence: envelope.globalSequence,
        at,
        eligible,
        debounceMinutes: config.debounceMinutes,
      });
    }
    return true;
  }

  private async workOnce(): Promise<void> {
    if (this.working || this.stopped) return;
    this.working = true;
    try {
      const config = this.options.getConfig();
      if (!config.enabled) return;
      // claim 前先把当前可见 run 边界消费完；若 scanner 已在跑则等待它收口。
      await this.scanOnce();
      if (this.stopped || !this.options.getConfig().enabled) return;
      const claimed = await this.options.store.claimDue({
        workerId: this.workerId,
        now: new Date().toISOString(),
        limit: config.workerConcurrency,
        leaseSeconds: config.leaseSeconds,
      });
      if (claimed.length > 0) {
        await Promise.all(claimed.map((state) => this.processState(state, config)));
      }
    } catch (err) {
      this.options.logger?.warn(`consolidation work failed: ${message(err)}`);
    } finally {
      this.working = false;
    }
  }

  private async processState(
    state: ConsolidationState,
    config: MemoryConsolidationResolvedConfig,
  ): Promise<void> {
    const log = this.options.logger;
    const now = new Date().toISOString();
    try {
      if (!this.options.isTenantEnabled(state.tenantId)) {
        await this.options.store.markFailed({
          tenantId: state.tenantId,
          sessionId: state.sessionId,
          toSequence: state.targetSessionSequence,
          boundarySequence: state.lastBoundaryGlobalSequence,
          ...(state.leaseOwner ? { leaseOwner: state.leaseOwner } : {}),
          now,
          backoffMinutes: CONSOLIDATION_RETRY_BACKOFF_MINUTES,
          maxRetries: 0,
          permanent: true,
        });
        return;
      }

      const projection = await this.options.projectionStore.get(state.sessionId);
      if (!projection) {
        await this.options.store.markFailed({
          tenantId: state.tenantId,
          sessionId: state.sessionId,
          toSequence: state.targetSessionSequence,
          boundarySequence: state.lastBoundaryGlobalSequence,
          ...(state.leaseOwner ? { leaseOwner: state.leaseOwner } : {}),
          now,
          backoffMinutes: CONSOLIDATION_RETRY_BACKOFF_MINUTES,
          maxRetries: config.maxRetries,
        });
        return;
      }
      if (projection.tenantId !== state.tenantId
        || projection.userId !== state.userId
        || !isEligibleProjection(projection, state.sessionId)) {
        await this.options.store.markIneligible({
          tenantId: state.tenantId,
          sessionId: state.sessionId,
          ...(state.leaseOwner ? { leaseOwner: state.leaseOwner } : {}),
        });
        log?.info(`consolidation discarded ineligible backlog session=${state.sessionId}`);
        return;
      }
      // scanner 的 active_run_ids 是 durable 主门禁；projection status 再做一次 claim 后复核，
      // 覆盖 run_started 刚落会话目录但全局边界事件尚未被 scanner 消费的窗口。
      if (projection.runtimeStatus === 'running') {
        await this.options.store.markFailed({
          tenantId: state.tenantId,
          sessionId: state.sessionId,
          toSequence: state.targetSessionSequence,
          boundarySequence: state.lastBoundaryGlobalSequence,
          ...(state.leaseOwner ? { leaseOwner: state.leaseOwner } : {}),
          now,
          backoffMinutes: [1],
          maxRetries: 9999,
        });
        return;
      }

      const user = this.options.userStore.findById(state.userId);
      if (!user || user.disabled) {
        await this.options.store.markFailed({
          tenantId: state.tenantId,
          sessionId: state.sessionId,
          toSequence: state.targetSessionSequence,
          boundarySequence: state.lastBoundaryGlobalSequence,
          ...(state.leaseOwner ? { leaseOwner: state.leaseOwner } : {}),
          now,
          backoffMinutes: CONSOLIDATION_RETRY_BACKOFF_MINUTES,
          maxRetries: 0,
          permanent: true,
        });
        return;
      }

      if (!tryAcquireMemoryMaintenance(state.tenantId, state.userId)) {
        await this.options.store.markFailed({
          tenantId: state.tenantId,
          sessionId: state.sessionId,
          toSequence: state.targetSessionSequence,
          boundarySequence: state.lastBoundaryGlobalSequence,
          ...(state.leaseOwner ? { leaseOwner: state.leaseOwner } : {}),
          now,
          backoffMinutes: [1],
          maxRetries: 9999,
        });
        return;
      }

      try {
        // 进程内门禁只防止同一用户重复启动 L2；真实文件写入由成功 Run 的
        // 草稿提交阶段持短时 PG 锁完成，不再让长时间模型推理阻塞显式记忆写入。
        await this.runConsolidation(state, config, user, projection.model);
      } finally {
        releaseMemoryMaintenance(state.tenantId, state.userId);
      }
    } catch (err) {
      log?.warn(`consolidation processState failed session=${state.sessionId}: ${message(err)}`);
      await this.options.store.markFailed({
        tenantId: state.tenantId,
        sessionId: state.sessionId,
        toSequence: state.targetSessionSequence,
        boundarySequence: state.lastBoundaryGlobalSequence,
        ...(state.leaseOwner ? { leaseOwner: state.leaseOwner } : {}),
        now: new Date().toISOString(),
        backoffMinutes: CONSOLIDATION_RETRY_BACKOFF_MINUTES,
        maxRetries: config.maxRetries,
      }).catch(() => undefined);
    }
  }

  private async runConsolidation(
    state: ConsolidationState,
    config: MemoryConsolidationResolvedConfig,
    user: { id: string; username: string; role: string; tenantId?: string },
    sourceModelRef?: string,
  ): Promise<void> {
    const from = state.processedSessionSequence;
    const to = state.targetSessionSequence;
    const idempotencyKey = createHash('sha256')
      .update(`${state.tenantId}|${state.sessionId}|${from}|${to}`)
      .digest('hex');
    const updateRunFenced = async (
      input: Parameters<PgMemoryConsolidationStore['updateRun']>[0],
    ): Promise<boolean> => state.leaseOwner ? this.options.store.updateRunFenced({
      ...input,
      tenantId: state.tenantId,
      sessionId: state.sessionId,
      leaseOwner: state.leaseOwner,
      fromSequence: from,
      toSequence: to,
      boundarySequence: state.lastBoundaryGlobalSequence,
    }) : false;
    const identity = {
      id: user.id,
      username: user.username,
      role: (user.role === 'admin' ? 'admin' : 'user') as 'admin' | 'user',
      ...(user.tenantId ? { tenantId: user.tenantId } : {}),
    };
    const effectiveCwd = resolveUserCwd(this.options.agentCwd, identity);
    const preparedRecord = await this.options.store.findPreparedCommitRun(
      state.tenantId,
      state.sessionId,
      from,
    );
    if (preparedRecord) {
      const preparedUsage = preparedRecord.usageJson as Record<string, unknown>;
      let recoveryLock: MemoryConsolidationCommitLock | null = null;
      try {
        recoveryLock = await this.options.store.acquireCommitLock(state.tenantId, state.userId, 5_000);
        if (!recoveryLock || !state.leaseOwner) {
          await this.options.store.markFailed({
            tenantId: state.tenantId,
            sessionId: state.sessionId,
            toSequence: to,
            boundarySequence: state.lastBoundaryGlobalSequence,
            ...(state.leaseOwner ? { leaseOwner: state.leaseOwner } : {}),
            now: new Date().toISOString(),
            backoffMinutes: [1],
            maxRetries: config.maxRetries,
          });
          return;
        }
        const fenceResult = await recoveryLock.acquireFence({
          tenantId: state.tenantId,
          sessionId: state.sessionId,
          leaseOwner: state.leaseOwner,
          now: new Date().toISOString(),
          fromSequence: from,
          toSequence: to,
          boundarySequence: state.lastBoundaryGlobalSequence,
        });
        if (!fenceResult.fence) return;
        const journalBoundarySequence = Number(preparedUsage.commitBoundarySequence);
        const sameGeneration = Number.isSafeInteger(journalBoundarySequence)
          && journalBoundarySequence === state.lastBoundaryGlobalSequence
          && preparedRecord.toSessionSequence === to;
        const preparedTombstoneIds = parseTombstoneSnapshot(preparedUsage.tombstoneIds);
        const currentTombstoneIds = await fenceResult.fence.listActiveTombstoneIds();
        const tombstonesChanged = !preparedTombstoneIds
          || !sameTombstoneSnapshot(preparedTombstoneIds, currentTombstoneIds);
        const recoveredUsage = { ...preparedUsage };
        delete recoveredUsage.commitJournal;
        delete recoveredUsage.commitBoundarySequence;
        try {
          if (sameGeneration && !tombstonesChanged) {
            try {
              const recovered = await recoverMemoryConsolidationPreparedCommit(
                effectiveCwd,
                preparedUsage.commitJournal,
              );
              await fenceResult.fence.finalizeApplied({
                idempotencyKey: preparedRecord.idempotencyKey,
                toSequence: to,
                debounceMinutes: config.debounceMinutes,
                now: new Date().toISOString(),
                ...(preparedRecord.modelActual ? { modelActual: preparedRecord.modelActual } : {}),
                usageJson: recoveredUsage,
              });
              this.options.logger?.warn(
                `consolidation recovered interrupted commit user=${state.userId} files=${recovered}`,
              );
              return;
            } catch (error) {
              if (!(error instanceof MemoryConsolidationDraftConflictError)) throw error;
            }
          }
          const rolledBack = await rollbackMemoryConsolidationPreparedCommit(
            effectiveCwd,
            preparedUsage.commitJournal,
          );
          await fenceResult.fence.retireJournalAndRequeue({
            idempotencyKey: preparedRecord.idempotencyKey,
            now: new Date().toISOString(),
            usageJson: recoveredUsage,
            errorCode: tombstonesChanged
              ? 'recovery_tombstone_superseded'
              : sameGeneration ? 'recovery_conflict_superseded' : 'recovery_boundary_superseded',
            errorMessage: tombstonesChanged
              ? 'prepared journal tombstone snapshot is stale'
              : sameGeneration
                ? 'prepared journal conflicts with the current Markdown baseline'
                : 'prepared journal was rolled back after the run boundary changed',
          });
          this.options.logger?.warn(
            `consolidation rolled back superseded journal session=${state.sessionId} files=${rolledBack}`,
          );
          return;
        } catch (error) {
          await fenceResult.fence.release().catch(() => undefined);
          throw error;
        }
      } finally {
        if (recoveryLock) await recoveryLock.release().catch(() => undefined);
      }
    }

    const { record } = await this.options.store.insertOrGetRun({
      idempotencyKey,
      tenantId: state.tenantId,
      userId: state.userId,
      workspaceId: state.workspaceId,
      sessionId: state.sessionId,
      fromSessionSequence: from,
      toSessionSequence: to,
      promptVersion: MEMORY_CONSOLIDATION_PROMPT_VERSION,
      ...(sourceModelRef ? { modelRequested: sourceModelRef } : {}),
    });
    if (record.status === 'applied' || record.status === 'noop') {
      await this.options.store.markApplied({
        tenantId: state.tenantId,
        sessionId: state.sessionId,
        ...(state.leaseOwner ? { leaseOwner: state.leaseOwner } : {}),
        toSequence: to,
        debounceMinutes: config.debounceMinutes,
        now: new Date().toISOString(),
      });
      return;
    }

    const tombstones = await this.options.store.listActiveTombstones(state.tenantId, state.userId);
    const tombstoneIds = tombstones.map((tombstone) => tombstone.id).sort();
    const forgottenSubjects = tombstones.map((tombstone) => {
      if (tombstone.scope === 'all_memory') return '全部既有记忆';
      return tombstone.subjectText ?? tombstone.memoryKey;
    }).filter((subject): subject is string => Boolean(subject?.trim()));

    const channelContext: ChannelContext = {
      channel: 'web',
      user: identity,
      systemContext: 'memory-consolidation',
    };
    const inbound: InboundMessage = {
      channel: 'web',
      chatId: `${CONSOLIDATION_CHAT_PREFIX}${Date.now()}`,
      content: buildConsolidationPrompt({
        fromSessionSequence: from,
        toSessionSequence: to,
        forgottenSubjects,
      }),
    };
    let dispatchError: string | undefined;
    let completed = false;
    let hiddenSessionId: string | undefined;
    const abort = new AbortController();
    let dispatchIterator: AsyncIterator<OutboundEvent> | undefined;
    let iteratorDrain: Promise<unknown> | undefined;
    let rejectTimeout!: (error: Error) => void;
    const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
    const timeoutTimer = setTimeout(() => {
      abort.abort('memory_consolidation_timeout');
      rejectTimeout(new Error(`L2 run timeout after ${config.timeoutSeconds}s`));
    }, config.timeoutSeconds * 1000);
    try {
      try {
        dispatchIterator = this.options.dispatch(inbound, channelContext, {
          maxTurns: config.maxTurns,
          cwd: effectiveCwd,
          approvalPolicy: { autoApproveTools: true },
          skipMemory: true,
          abortController: abort,
          memoryConsolidationSourceSessionId: state.sessionId,
        })[Symbol.asyncIterator]();
        for (;;) {
          const next = await Promise.race([dispatchIterator.next(), timeout]);
          if (next.done) break;
          const event = next.value;
          if (event.type === 'session_init' && event.sessionId) hiddenSessionId = event.sessionId;
          if (event.type === 'error') dispatchError = event.error || 'unknown error';
          if (event.type === 'done') completed = true;
          if (abort.signal.aborted) break;
        }
      } catch (error) {
        dispatchError = message(error);
      }
    } finally {
      clearTimeout(timeoutTimer);
      if (abort.signal.aborted && dispatchIterator?.return) {
        iteratorDrain = Promise.resolve().then(() => dispatchIterator!.return!());
      }
    }

    if (abort.signal.aborted) {
      await this.cleanupAbortedDraft(hiddenSessionId, iteratorDrain);
      await this.failRun(state, config, idempotencyKey, 'timeout',
        `L2 run timeout after ${config.timeoutSeconds}s`, hiddenSessionId);
      return;
    }
    if (!completed || dispatchError || !hiddenSessionId) {
      await discardMemoryConsolidationDraft(hiddenSessionId);
      await this.failRun(
        state,
        config,
        idempotencyKey,
        dispatchError ? 'dispatch_error' : 'incomplete_run',
        dispatchError ?? 'L2 hidden run finished without session_init/done event',
        hiddenSessionId,
      );
      return;
    }

    const leaseRenewed = await (async () => {
      try {
        return state.leaseOwner
          ? await this.options.store.renewLease({
              tenantId: state.tenantId,
              sessionId: state.sessionId,
              leaseOwner: state.leaseOwner,
              now: new Date().toISOString(),
              leaseSeconds: 300,
            })
          : false;
      } catch (error) {
        await discardMemoryConsolidationDraft(hiddenSessionId);
        throw error;
      }
    })();
    if (!leaseRenewed) {
      await discardMemoryConsolidationDraft(hiddenSessionId);
      this.options.logger?.warn(`consolidation lease lost before commit session=${state.sessionId}`);
      return;
    }

    const preparedDraft = await (async () => {
      try {
        const usage = await this.readHiddenRunUsage(hiddenSessionId);
        const draftPlan = await inspectMemoryConsolidationDraft(hiddenSessionId);
        const preparedUsage = {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          hiddenSessionId,
          changedFiles: draftPlan.changedFiles,
          commitJournal: draftPlan.commitJournal,
          commitBoundarySequence: state.lastBoundaryGlobalSequence,
          tombstoneIds,
        };
        const prepared = await updateRunFenced({
          idempotencyKey,
          status: 'prepared',
          ...(usage.modelActual ? { modelActual: usage.modelActual } : {}),
          usageJson: preparedUsage,
        });
        if (!prepared) {
          await discardMemoryConsolidationDraft(hiddenSessionId);
          return null;
        }
        return { usage, draftPlan, preparedUsage };
      } catch (error) {
        await discardMemoryConsolidationDraft(hiddenSessionId);
        throw error;
      }
    })();
    if (!preparedDraft) return;
    const { usage, draftPlan, preparedUsage } = preparedDraft;

    let commitLock: MemoryConsolidationCommitLock | null = null;
    let commitFence: MemoryConsolidationCommitFence | null = null;
    let commitError: unknown;
    let filesCommitted = false;
    let leaseLostBeforeCommit = false;
    let boundaryChangedBeforeCommit = false;
    try {
      commitLock = await this.options.store.acquireCommitLock(state.tenantId, state.userId, 5_000);
      if (!commitLock) commitError = new Error('L2 memory draft commit lock unavailable');
      else if (!state.leaseOwner) {
        leaseLostBeforeCommit = true;
        commitError = new Error('L2 memory draft lease missing before commit');
      } else {
        const fenceResult = await commitLock.acquireFence({
          tenantId: state.tenantId,
          sessionId: state.sessionId,
          leaseOwner: state.leaseOwner,
          now: new Date().toISOString(),
          fromSequence: from,
          toSequence: to,
          boundarySequence: state.lastBoundaryGlobalSequence,
        });
        commitFence = fenceResult.fence;
        boundaryChangedBeforeCommit = fenceResult.boundaryChanged;
        if (!commitFence) {
          leaseLostBeforeCommit = true;
          commitError = new Error('L2 memory draft state fence lost before commit');
        } else {
          const currentTombstoneIds = await commitFence.listActiveTombstoneIds();
          if (!sameTombstoneSnapshot(tombstoneIds, currentTombstoneIds)) {
            const retiredUsage: Record<string, unknown> = { ...preparedUsage };
            delete retiredUsage.commitJournal;
            delete retiredUsage.commitBoundarySequence;
            await commitFence.retireJournalAndRequeue({
              idempotencyKey,
              now: new Date().toISOString(),
              usageJson: retiredUsage,
              errorCode: 'commit_tombstone_superseded',
              errorMessage: 'active tombstones changed while the hidden consolidation run was executing',
            });
            await discardMemoryConsolidationDraft(hiddenSessionId);
            this.options.logger?.warn(
              `consolidation tombstones changed before commit session=${state.sessionId}; requeued`,
            );
            return;
          }
          await commitMemoryConsolidationDraft(hiddenSessionId);
          filesCommitted = true;
          await commitFence.finalizeApplied({
            idempotencyKey,
            toSequence: to,
            debounceMinutes: config.debounceMinutes,
            now: new Date().toISOString(),
            ...(usage.modelActual ? { modelActual: usage.modelActual } : {}),
            usageJson: {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheReadTokens: usage.cacheReadTokens,
              hiddenSessionId,
              changedFiles: draftPlan.changedFiles,
            },
          });
        }
      }
    } catch (error) {
      commitError = error;
    } finally {
      if (commitFence) await commitFence.release().catch(() => undefined);
      if (commitLock) await commitLock.release().catch(() => undefined);
    }
    if (commitError) {
      await discardMemoryConsolidationDraft(hiddenSessionId);
      // 文件已全部 rename 后，COMMIT 失败可能只是确认响应丢失；保留 prepared ledger，
      // 让下一次 claim 通过 journal 判定 DB 实际结果，绝不能把已 applied 的 ledger 回写为失败。
      if (filesCommitted || (leaseLostBeforeCommit && !boundaryChangedBeforeCommit)) return;
      const conflict = commitError instanceof MemoryConsolidationDraftConflictError;
      await this.failRun(
        state,
        config,
        idempotencyKey,
        conflict
          ? 'commit_conflict'
          : leaseLostBeforeCommit
            ? 'commit_boundary_superseded'
            : commitLock ? 'commit_error' : 'commit_lock_timeout',
        message(commitError),
        hiddenSessionId,
        !conflict && !leaseLostBeforeCommit && commitLock
          ? draftPlan.commitJournal
          : undefined,
        tombstoneIds,
      );
      return;
    }

    this.options.logger?.info(
      `consolidation applied session=${state.sessionId} range=(${from},${to}] `
      + `hidden=${hiddenSessionId ?? 'unknown'} input=${usage.inputTokens} cached=${usage.cacheReadTokens}`,
    );
  }

  private async cleanupAbortedDraft(
    hiddenSessionId: string | undefined,
    iteratorDrain: Promise<unknown> | undefined,
  ): Promise<void> {
    const cleanup = Promise.allSettled([
      iteratorDrain ?? Promise.resolve(),
      discardMemoryConsolidationDraft(hiddenSessionId),
    ]).then(async (results) => {
      // iterator drain 期间若还有迟到工具调用，二次清理负责关闭其新建草稿。
      await discardMemoryConsolidationDraft(hiddenSessionId);
      const rejected = results.find((result) => result.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
    });
    const observedCleanup = cleanup.catch((error) => {
      this.options.logger?.warn(
        `consolidation aborted draft cleanup failed hidden=${hiddenSessionId ?? 'unknown'}: ${message(error)}`,
      );
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      observedCleanup.then(() => false),
      new Promise<true>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(true), DRAFT_CLEANUP_WAIT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) {
      this.options.logger?.warn(
        `consolidation aborted draft cleanup continues in background hidden=${hiddenSessionId ?? 'unknown'}`,
      );
      // 不依赖 iterator drain：再次同步启动 closing fence，迟到草稿也进入后台排空。
      void discardMemoryConsolidationDraft(hiddenSessionId).catch((error) => {
        this.options.logger?.warn(
          `consolidation late draft cleanup failed hidden=${hiddenSessionId ?? 'unknown'}: ${message(error)}`,
        );
      });
      void observedCleanup;
    }
  }

  private async failRun(
    state: ConsolidationState,
    config: MemoryConsolidationResolvedConfig,
    idempotencyKey: string,
    errorCode: string,
    errorMessage: string,
    hiddenSessionId?: string,
    commitJournal?: unknown,
    tombstoneIds?: string[],
  ): Promise<void> {
    const usage = hiddenSessionId ? await this.readHiddenRunUsage(hiddenSessionId) : undefined;
    if (!state.leaseOwner) return;
    await this.options.store.failRunAndState({
      idempotencyKey,
      tenantId: state.tenantId,
      sessionId: state.sessionId,
      leaseOwner: state.leaseOwner,
      toSequence: state.targetSessionSequence,
      boundarySequence: state.lastBoundaryGlobalSequence,
      now: new Date().toISOString(),
      backoffMinutes: CONSOLIDATION_RETRY_BACKOFF_MINUTES,
      maxRetries: config.maxRetries,
      ...(usage?.modelActual ? { modelActual: usage.modelActual } : {}),
      ...(usage ? {
        usageJson: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          hiddenSessionId,
          ...(commitJournal ? {
            commitJournal,
            commitBoundarySequence: state.lastBoundaryGlobalSequence,
            tombstoneIds: tombstoneIds ?? [],
          } : {}),
        },
      } : {}),
      errorCode,
      errorMessage,
    });
  }

  private async readHiddenRunUsage(hiddenSessionId: string): Promise<{
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    modelActual?: string;
  }> {
    const rows = await this.options.eventStore.listSessionRange(hiddenSessionId, {
      fromExclusive: 0,
      toInclusive: Number.MAX_SAFE_INTEGER,
      limit: 2_000,
    }).catch(() => []);
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let modelActual: string | undefined;
    for (const { event } of rows) {
      if (event.type !== 'assistant_message' && event.type !== 'assistant_tool_calls') continue;
      const usage = event.usage;
      if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
        const values = usage as Record<string, unknown>;
        inputTokens += numberOrZero(values.inputTokens);
        outputTokens += numberOrZero(values.outputTokens);
        cacheReadTokens += numberOrZero(values.cacheReadInputTokens);
      }
      if (typeof event.model === 'string') modelActual = event.model;
    }
    return { inputTokens, outputTokens, cacheReadTokens, ...(modelActual ? { modelActual } : {}) };
  }
}

function parseTombstoneSnapshot(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) return null;
  const sorted = [...value].sort();
  return new Set(sorted).size === sorted.length ? sorted : null;
}

function sameTombstoneSnapshot(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedRight = [...right].sort();
  return left.every((id, index) => id === sortedRight[index]);
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
