/**
 * L2 记忆整合引擎：scanner（durable global cursor 消费 run 边界事件）+
 * worker（claim 到期会话 → digest → 隐藏 L2 run → MemoryCommit 落盘 → 推进游标）。
 *
 * 触发正确性来自 PG 全局游标扫描；`subscribeAppended` 只作低延迟唤醒
 * （它对首见会话不回放历史，进程重启后旧会话可能永远等不到通知）。
 * 蓝绿并存：scanner 用 PG advisory lock 选主（复用 CronLeadership 同款思路，
 * 此处直接依赖 claimDue 的 SKIP LOCKED + consumer cursor 单调推进保证不重不漏，
 * scanner 双跑只浪费不出错）。
 *
 * 租户门禁：只为 features.memoryConsolidationEnabled=true 的租户建 state；
 * 未开启租户的事件直接跳过并推进 cursor（开启后从开启时刻的新事件开始积累，
 * 不回填历史——曾磊 2026-07-29 拍板「机制全量上线 + 租户开关默认关、仅开 kaiyan」）。
 */

import { createHash, randomUUID } from 'node:crypto';

import type { AgentRunDispatch } from '../../agent/types.js';
import type { ChannelContext, InboundMessage } from '../../types/index.js';
import { resolveUserCwd } from '../../workspace/resolver.js';
import { tryAcquireMemoryMaintenance, releaseMemoryMaintenance } from '../maintenanceLock.js';
import { buildMemoryDigest, type DigestSourceEvent } from './digest.js';
import { buildConsolidationPrompt, MEMORY_CONSOLIDATION_PROMPT_VERSION } from './prompt.js';
import { formatMemoryDate, materializeDailyOperations, readDailyFileHash } from './materialize.js';
import { PgMemoryConsolidationStore } from './store.js';
import {
  CONSOLIDATION_RETRY_BACKOFF_MINUTES,
  type ConsolidationExecutionContext,
  type ConsolidationState,
  type MemoryCandidateOperation,
  type MemoryConsolidationResolvedConfig,
} from './types.js';

// ── MemoryCommit 执行上下文注册表（worker 写入、tool provider 读取）────────

const executionContexts = new Map<string, ConsolidationExecutionContext>();

function contextKey(tenantId: string | undefined, userId: string): string {
  return `${tenantId ?? '__none'}:${userId}`;
}

export function getConsolidationExecutionContext(
  tenantId: string | undefined,
  userId: string,
): ConsolidationExecutionContext | undefined {
  return executionContexts.get(contextKey(tenantId, userId));
}

// ── 引擎依赖 ───────────────────────────────────────────────────

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
  }): Promise<Array<{ sessionSequence: number; event: Record<string, unknown> & { type: string; id: string } }>>;
}

interface ProjectionStoreForConsolidation {
  get(sessionId: string, options?: { includeDeleted?: boolean }): Promise<{
    sessionId: string;
    tenantId: string;
    userId?: string;
    username?: string;
    channel?: string;
    kind: 'user' | 'subagent';
    workspaceId?: string;
    metaJson: { cronSystemKind?: string; cronJobName?: string; kind?: string; memoryPolicyVersion?: string };
  } | null>;
}

export interface MemoryConsolidationEngineOptions {
  store: PgMemoryConsolidationStore;
  eventStore: EventStoreForConsolidation;
  projectionStore: ProjectionStoreForConsolidation;
  userStore: {
    findById(id: string): { id: string; username: string; role: string; tenantId?: string; disabled?: boolean } | undefined;
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

/**
 * 事件切片（2026-07-29 P1 修复的核心纯函数，独立导出供合同测试）。
 * 返回本次实际处理的事件与 effectiveTo：token 预算切断 → 切断点；DB 行数
 * 截断 → 最后读到的行；否则 → target。effectiveTo < target 即 rangeTruncated，
 * 剩余段由 markApplied 的 target 超前逻辑自动保持 pending 续处理。
 */
export function sliceEventsByBudget(input: {
  rows: Array<{ sessionSequence: number; event: Record<string, unknown> }>;
  target: number;
  maxInputTokens: number;
  dbRowLimit: number;
}): { sliced: Array<{ sessionSequence: number; event: Record<string, unknown> }>; effectiveTo: number; rangeTruncated: boolean } {
  const dbTruncated = input.rows.length >= input.dbRowLimit;
  const sliced: Array<{ sessionSequence: number; event: Record<string, unknown> }> = [];
  let tokenBudget = 0;
  let tokenTruncated = false;
  for (const row of input.rows) {
    const rawContent = row.event.content;
    const content = typeof rawContent === 'string' ? rawContent : '';
    const estimated = Math.ceil(content.length / 3) + 50;
    if (sliced.length > 0 && tokenBudget + estimated > input.maxInputTokens) {
      tokenTruncated = true;
      break;
    }
    sliced.push(row);
    tokenBudget += estimated;
  }
  const effectiveTo = tokenTruncated
    ? sliced[sliced.length - 1]!.sessionSequence
    : dbTruncated
      ? input.rows[input.rows.length - 1]!.sessionSequence
      : input.target;
  return { sliced, effectiveTo, rangeTruncated: effectiveTo < input.target };
}

const CONSUMER_NAME = 'memory-consolidation-v1';
const CONSOLIDATION_CHAT_PREFIX = 'memory-consolidate-';
/** L2/L3 自身与子 agent 会话绝不能再被提取（防自我喂养）。 */
const EXCLUDED_CHANNELS = new Set(['cron']);

export class MemoryConsolidationEngine {
  private scanTimer: ReturnType<typeof setInterval> | undefined;
  private workTimer: ReturnType<typeof setInterval> | undefined;
  private reviveTimer: ReturnType<typeof setInterval> | undefined;
  private scanning = false;
  private working = false;
  private stopped = true;
  private readonly workerId = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;

  constructor(private readonly options: MemoryConsolidationEngineOptions) {}

  async start(): Promise<void> {
    this.stopped = false;
    const config = this.options.getConfig();
    await this.options.store.init();
    this.scanTimer = setInterval(() => { void this.scanOnce(); }, config.scanIntervalMs);
    this.scanTimer.unref?.();
    this.workTimer = setInterval(() => { void this.workOnce(); }, Math.max(config.scanIntervalMs, 5_000));
    this.workTimer.unref?.();
    // throttled 状态每小时复核一次（跨 UTC 日界后配额刷新）
    this.reviveTimer = setInterval(() => {
      void this.options.store.reviveThrottled(new Date().toISOString(), this.options.getConfig().debounceMinutes)
        .catch((err) => this.options.logger?.warn(`consolidation reviveThrottled failed: ${message(err)}`));
    }, 3600_000);
    this.reviveTimer.unref?.();
    void this.scanOnce();
    this.options.logger?.info(`MemoryConsolidationEngine started (${this.workerId})`);
  }

  stop(): void {
    this.stopped = true;
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.workTimer) clearInterval(this.workTimer);
    if (this.reviveTimer) clearInterval(this.reviveTimer);
    this.scanTimer = this.workTimer = this.reviveTimer = undefined;
  }

  /** NOTIFY 唤醒（低延迟路径）；正确性不依赖此调用。 */
  wake(): void {
    void this.scanOnce();
    void this.workOnce();
  }

  // ── scanner：durable global cursor 消费 ─────────────────────

  private async scanOnce(): Promise<void> {
    if (this.scanning || this.stopped) return;
    this.scanning = true;
    try {
      const config = this.options.getConfig();
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
          const ok = await this.applyEnvelope(envelope, config);
          if (!ok) {
            // fail-closed（曾磊拍板的首版降级）：projection 暂缺时停在该
            // sequence，不推进、不静默跳过；靠下一轮扫描重试 + warn 告警。
            if (lastApplied > cursor) {
              await this.options.store.advanceConsumerCursor(CONSUMER_NAME, lastApplied);
            }
            return;
          }
          lastApplied = envelope.globalSequence;
        }
        await this.options.store.advanceConsumerCursor(CONSUMER_NAME, lastApplied);
        if (!page.hasMore) return;
      }
    } catch (err) {
      this.options.logger?.warn(`consolidation scan failed: ${message(err)}`);
    } finally {
      this.scanning = false;
    }
  }

  /** 返回 false = projection 暂缺，调用方必须停止推进 cursor。 */
  private async applyEnvelope(
    envelope: Awaited<ReturnType<EventStoreForConsolidation['listGlobalPage']>>['events'][number],
    config: MemoryConsolidationResolvedConfig,
  ): Promise<boolean> {
    const event = envelope.event;
    const projection = await this.options.projectionStore.get(envelope.sessionId, { includeDeleted: true });
    if (!projection) {
      // run_started 先于 projection 落库是正常时序；warn 并 fail-closed 等待。
      this.options.logger?.warn(
        `consolidation scanner: session projection missing for ${envelope.sessionId} (global_seq=${envelope.globalSequence}), holding cursor`,
      );
      return false;
    }
    // 跳过：非用户会话（subagent）、cron 系统会话（memory_poll 等）、隐藏维护会话、未开启租户。
    // 2026-07-29 P1 修复：只处理 memoryPolicyVersion=v2 的会话——存量 v1 会话仍由
    // 主 Agent 按 v1 提示语自主写记忆，L2 若同时提取会造成双写；缺 pin 的旧会话
    // 一律视为 v1，不隐式接管。
    const meta = projection.metaJson ?? {};
    const skip = projection.kind !== 'user'
      || meta.cronSystemKind !== undefined
      || meta.memoryPolicyVersion !== 'v2'
      || (projection.channel !== undefined && EXCLUDED_CHANNELS.has(projection.channel))
      || envelope.sessionId.startsWith('memory-maint-')
      || envelope.sessionId.startsWith(CONSOLIDATION_CHAT_PREFIX)
      || !projection.userId
      || !this.options.isTenantEnabled(envelope.tenantId);
    if (skip) return true;

    const user = this.options.userStore.findById(projection.userId!);
    if (!user || user.disabled) return true;

    const base = {
      tenantId: envelope.tenantId,
      userId: projection.userId!,
      workspaceId: projection.workspaceId ?? projection.username ?? projection.userId!,
      sessionId: envelope.sessionId,
    };
    const runId = typeof event.runId === 'string' ? (event.runId as string) : 'unknown-run';
    const at = typeof event.timestamp === 'string' ? (event.timestamp as string) : new Date().toISOString();

    if (event.type === 'run_started') {
      await this.options.store.applyRunStarted({ ...base, runId, at });
      return true;
    }
    if (event.type === 'run_finished') {
      const subtype = typeof event.subtype === 'string' ? event.subtype : 'success';
      const eligible = subtype === 'success'
        || (subtype === 'interrupted' && config.includeInterrupted)
        || (subtype === 'error' && config.includeError);
      await this.options.store.applyRunFinished({
        ...base,
        runId,
        sessionSequence: envelope.sessionSequence,
        at,
        eligible,
        debounceMinutes: config.debounceMinutes,
      });
      return true;
    }
    return true;
  }

  // ── worker：claim → digest → L2 run → commit → 游标推进 ─────

  private async workOnce(): Promise<void> {
    if (this.working || this.stopped) return;
    this.working = true;
    try {
      const config = this.options.getConfig();
      const claimed = await this.options.store.claimDue({
        workerId: this.workerId,
        now: new Date().toISOString(),
        limit: config.workerConcurrency,
        maxDeferralMinutes: config.maxDeferralMinutes,
        leaseSeconds: config.leaseSeconds,
      });
      if (claimed.length === 0) return;
      await Promise.all(claimed.map((state) => this.processState(state, config)));
    } catch (err) {
      this.options.logger?.warn(`consolidation work failed: ${message(err)}`);
    } finally {
      this.working = false;
    }
  }

  private async processState(state: ConsolidationState, config: MemoryConsolidationResolvedConfig): Promise<void> {
    const log = this.options.logger;
    const now = new Date().toISOString();
    try {
      // 租户开关可能在 pending 期间被关：不丢 backlog，转 blocked 保留游标。
      if (!this.options.isTenantEnabled(state.tenantId)) {
        await this.options.store.markFailed({
          tenantId: state.tenantId, sessionId: state.sessionId, now,
          backoffMinutes: CONSOLIDATION_RETRY_BACKOFF_MINUTES, maxRetries: 0, permanent: true,
        });
        return;
      }
      // 单用户日配额熔断：保留 pending（throttled），不推进游标。
      const daily = await this.options.store.getUserDailyUsage(state.tenantId, state.userId);
      if (daily.runs >= config.maxConsolidationsPerUserPerDay
        || daily.inputTokens >= config.maxInputTokensPerUserPerDay) {
        await this.options.store.markThrottled({ tenantId: state.tenantId, sessionId: state.sessionId });
        log?.info(`consolidation throttled user=${state.userId} runs=${daily.runs} tokens=${daily.inputTokens}`);
        return;
      }

      const user = this.options.userStore.findById(state.userId);
      if (!user || user.disabled) {
        await this.options.store.markFailed({
          tenantId: state.tenantId, sessionId: state.sessionId, now,
          backoffMinutes: CONSOLIDATION_RETRY_BACKOFF_MINUTES, maxRetries: 0, permanent: true,
        });
        return;
      }

      // 同用户互斥：与 memory_poll/memoryHook 共用进程内锁（fast-path）；
      // 文件级正确性由 MemoryCommit 内的 PG commit lock 保证。
      if (!tryAcquireMemoryMaintenance(state.tenantId, state.userId)) {
        await this.options.store.markFailed({
          tenantId: state.tenantId, sessionId: state.sessionId, now,
          backoffMinutes: [1], maxRetries: 9999,
        });
        return;
      }
      const registryKey = contextKey(state.tenantId, state.userId);
      if (executionContexts.has(registryKey)) {
        releaseMemoryMaintenance(state.tenantId, state.userId);
        await this.options.store.markFailed({
          tenantId: state.tenantId, sessionId: state.sessionId, now,
          backoffMinutes: [1], maxRetries: 9999,
        });
        return;
      }

      try {
        await this.runConsolidation(state, config, user, registryKey);
      } finally {
        executionContexts.delete(registryKey);
        releaseMemoryMaintenance(state.tenantId, state.userId);
      }
    } catch (err) {
      log?.warn(`consolidation processState failed session=${state.sessionId}: ${message(err)}`);
      await this.options.store.markFailed({
        tenantId: state.tenantId, sessionId: state.sessionId, now: new Date().toISOString(),
        backoffMinutes: CONSOLIDATION_RETRY_BACKOFF_MINUTES, maxRetries: config.maxRetries,
      }).catch(() => undefined);
    }
  }

  private async runConsolidation(
    state: ConsolidationState,
    config: MemoryConsolidationResolvedConfig,
    user: { id: string; username: string; role: string; tenantId?: string },
    registryKey: string,
  ): Promise<void> {
    const log = this.options.logger;
    const from = state.processedSessionSequence;
    const to = state.targetSessionSequence;

    // ── 读取事件并按预算切片（2026-07-29 P1 修复：截断时游标只推进到实际
    // 处理边界，剩余段保持 pending 续处理，绝不静默丢弃）────────────────
    const EVENT_ROW_LIMIT = 2_000;
    const rows = await this.options.eventStore.listSessionRange(state.sessionId, {
      fromExclusive: from,
      toInclusive: to,
      excludeTypes: ['assistant_stream_event', 'assistant_thinking', 'memory_context', 'compaction'],
      limit: EVENT_ROW_LIMIT,
    });
    const slice = sliceEventsByBudget({
      rows,
      target: to,
      maxInputTokens: config.maxInputTokens,
      dbRowLimit: EVENT_ROW_LIMIT,
    });
    const sliced: DigestSourceEvent[] = slice.sliced.map((row) => ({
      sessionSequence: row.sessionSequence,
      event: row.event as never,
    }));
    const effectiveTo = slice.effectiveTo;
    const rangeTruncated = slice.rangeTruncated;

    const idempotencyKey = createHash('sha256')
      .update(`${state.tenantId}|${state.sessionId}|${from}|${effectiveTo}`)
      .digest('hex');

    const { record } = await this.options.store.insertOrGetRun({
      idempotencyKey,
      tenantId: state.tenantId,
      userId: state.userId,
      workspaceId: state.workspaceId,
      sessionId: state.sessionId,
      fromSessionSequence: from,
      toSessionSequence: effectiveTo,
      promptVersion: MEMORY_CONSOLIDATION_PROMPT_VERSION,
      ...(config.model ? { modelRequested: config.model } : {}),
    });
    // 幂等恢复：已终态的同范围 ledger 直接对齐游标，不再烧模型。
    if (record.status === 'applied' || record.status === 'noop') {
      await this.options.store.markApplied({
        tenantId: state.tenantId, sessionId: state.sessionId, toSequence: effectiveTo,
        debounceMinutes: config.debounceMinutes, now: new Date().toISOString(),
      });
      return;
    }
    // 崩溃恢复（2026-07-29 P1 修复）：prepared = proposal 已持久化、文件写入
    // 状态未知。按当前文件 hash 三分：已是 postimage → 补账；仍是 base →
    // 服务端直接重放 proposal（不烧模型）；两者都不是 → 文件被其他写入者
    // 推进过，回 started 走正常模型路径（写前会重读基线）。
    if (record.status === 'prepared' && record.plannedPostimageHash && record.baseMemoryHash) {
      const recovered = await this.recoverPreparedRun(state, record, config, user);
      if (recovered) return;
    }

    const digest = buildMemoryDigest({
      sourceEvents: sliced,
      anchorEvents: [],
      fromSequence: from,
      toSequence: effectiveTo,
      maxInputTokens: config.maxInputTokens,
    });

    if (digest.evidenceIndex.size === 0) {
      // 范围内没有可作证据的对话内容（如纯工具审计），按 noop 收口。
      await this.options.store.updateRun({ idempotencyKey, status: 'noop', finished: true });
      await this.options.store.markApplied({
        tenantId: state.tenantId, sessionId: state.sessionId, toSequence: effectiveTo,
        debounceMinutes: config.debounceMinutes, now: new Date().toISOString(),
      });
      return;
    }

    await this.options.store.updateRun({ idempotencyKey, inputHash: digest.inputHash });

    const executionContext: ConsolidationExecutionContext = {
      tenantId: state.tenantId,
      userId: state.userId,
      username: user.username,
      workspaceId: state.workspaceId,
      sourceSessionId: state.sessionId,
      fromSessionSequence: from,
      toSessionSequence: effectiveTo,
      idempotencyKey,
      consolidationRunId: record.id,
      evidenceIndex: digest.evidenceIndex,
    };
    executionContexts.set(registryKey, executionContext);

    const identity = {
      id: user.id,
      username: user.username,
      role: (user.role === 'admin' ? 'admin' : 'user') as 'admin' | 'user',
      ...(user.tenantId ? { tenantId: user.tenantId } : {}),
    };
    const channelContext: ChannelContext = {
      channel: 'web',
      user: identity,
      systemContext: 'memory-consolidation',
    };
    const inbound: InboundMessage = {
      channel: 'web',
      chatId: `${CONSOLIDATION_CHAT_PREFIX}${Date.now()}`,
      content: buildConsolidationPrompt({ digestText: digest.text, maxCandidates: config.maxCandidates }),
    };
    const effectiveCwd = resolveUserCwd(this.options.agentCwd, identity);

    let dispatchError: string | undefined;
    const timeoutMs = config.timeoutSeconds * 1000;
    const abort = new AbortController();
    const timeoutTimer = setTimeout(() => abort.abort('memory_consolidation_timeout'), timeoutMs);
    try {
      for await (const event of this.options.dispatch(
        inbound,
        channelContext,
        {
          maxTurns: config.maxTurns,
          persistSession: false,
          cwd: effectiveCwd,
          toolProfile: 'memory_consolidate',
          approvalPolicy: { autoApproveTools: true },
          executionTarget: 'server-remote',
          skipPersona: true,
          skipMemory: true,
          // 2026-07-29 P2 修复：controller 必须传给 dispatch，超时才能真正
          // 取消底层 run（否则 timer 只是没人监听的摆设，维护锁被长期占用）。
          abortController: abort,
          ...(config.model ? { model: config.model } : {}),
          ...(config.reasoningEffort
            ? { modelProviderOptions: { reasoningEffort: config.reasoningEffort } }
            : {}),
        } as never,
      )) {
        if (abort.signal.aborted) break;
        if (event.type === 'error') dispatchError = event.error || 'unknown error';
        else if (event.type === 'done') dispatchError = undefined;
      }
    } finally {
      clearTimeout(timeoutTimer);
    }

    const commit = executionContext.commitResult;
    if (abort.signal.aborted && !commit) {
      await this.options.store.updateRun({
        idempotencyKey, status: 'retryable_failed', incrementRetry: true,
        errorCode: 'timeout', errorMessage: `L2 run timeout after ${config.timeoutSeconds}s`, finished: true,
      });
      await this.options.store.markFailed({
        tenantId: state.tenantId, sessionId: state.sessionId, now: new Date().toISOString(),
        backoffMinutes: CONSOLIDATION_RETRY_BACKOFF_MINUTES, maxRetries: config.maxRetries,
      });
      return;
    }
    if (!commit) {
      // 模型没有调用 MemoryCommit（或 run 失败）：可重试，游标不动。
      await this.options.store.updateRun({
        idempotencyKey, status: 'retryable_failed', incrementRetry: true,
        errorCode: dispatchError ? 'dispatch_error' : 'no_commit',
        errorMessage: dispatchError ?? 'L2 run finished without MemoryCommit call', finished: true,
      });
      await this.options.store.markFailed({
        tenantId: state.tenantId, sessionId: state.sessionId, now: new Date().toISOString(),
        backoffMinutes: CONSOLIDATION_RETRY_BACKOFF_MINUTES, maxRetries: config.maxRetries,
      });
      return;
    }

    // MemoryCommit 内已完成文件写入与 ledger 状态（applied/noop/rejected/tombstone_blocked）
    if (commit.status === 'applied' || commit.status === 'noop') {
      await this.options.store.markApplied({
        tenantId: state.tenantId, sessionId: state.sessionId, toSequence: effectiveTo,
        debounceMinutes: config.debounceMinutes, now: new Date().toISOString(),
      });
      log?.info(
        `consolidation ${commit.status} session=${state.sessionId} range=(${from},${effectiveTo}]`
        + `${rangeTruncated ? ` truncated(target=${to})` : ''} applied=${commit.appliedCount} rejected=${commit.rejectedCount}`,
      );
    } else {
      // rejected/tombstone_blocked：范围内容被安全层整体拒绝——按处理完成推进
      // 游标（重跑同一范围只会再次被拒），但保留 ledger 供审计。
      await this.options.store.markApplied({
        tenantId: state.tenantId, sessionId: state.sessionId, toSequence: effectiveTo,
        debounceMinutes: config.debounceMinutes, now: new Date().toISOString(),
      });
      log?.warn(
        `consolidation ${commit.status} session=${state.sessionId} range=(${from},${effectiveTo}] — all candidates rejected`,
      );
    }
  }

  /**
   * prepared 崩溃恢复（2026-07-29 P1 修复）。返回 true = 已恢复收口（调用方
   * 直接返回）；false = 需要走正常模型路径（record 已回 started）。
   */
  private async recoverPreparedRun(
    state: ConsolidationState,
    record: { idempotencyKey: string; toSessionSequence: number; baseMemoryHash: string | null; plannedPostimageHash: string | null; proposalJson: unknown },
    config: MemoryConsolidationResolvedConfig,
    user: { id: string; username: string; role: string; tenantId?: string },
  ): Promise<boolean> {
    const log = this.options.logger;
    const identity = {
      id: user.id,
      username: user.username,
      role: (user.role === 'admin' ? 'admin' : 'user') as 'admin' | 'user',
      ...(user.tenantId ? { tenantId: user.tenantId } : {}),
    };
    const workspaceRoot = resolveUserCwd(this.options.agentCwd, identity);
    const proposal = record.proposalJson as { date?: string; operations?: unknown[]; accepted?: MemoryCandidateOperation[] } | null;
    const date = typeof proposal?.date === 'string' ? proposal.date : formatMemoryDate();
    const lock = await this.options.store.acquireCommitLock(state.tenantId, state.userId);
    if (!lock) return false;
    try {
      const currentHash = await readDailyFileHash(workspaceRoot, date);
      if (currentHash === record.plannedPostimageHash) {
        // 文件已写、DB 未标记 → 补账，不重复写
        await this.options.store.updateRun({ idempotencyKey: record.idempotencyKey, status: 'applied', applied: true, finished: true });
        await this.options.store.markApplied({
          tenantId: state.tenantId, sessionId: state.sessionId, toSequence: record.toSessionSequence,
          debounceMinutes: config.debounceMinutes, now: new Date().toISOString(),
        });
        log?.info(`consolidation prepared-recovery: postimage matched, backfilled applied session=${state.sessionId}`);
        return true;
      }
      const accepted = Array.isArray(proposal?.accepted) ? proposal!.accepted! : [];
      if (currentHash === record.baseMemoryHash && accepted.length > 0) {
        // 文件未写 → 服务端直接重放已校验 proposal，不再烧模型
        const result = await materializeDailyOperations({ workspaceRoot, operations: accepted, date });
        await this.options.store.updateRun({
          idempotencyKey: record.idempotencyKey, status: 'applied',
          plannedPostimageHash: result.postimageHash, applied: true, finished: true,
        });
        await this.options.store.markApplied({
          tenantId: state.tenantId, sessionId: state.sessionId, toSequence: record.toSessionSequence,
          debounceMinutes: config.debounceMinutes, now: new Date().toISOString(),
        });
        log?.info(`consolidation prepared-recovery: replayed proposal session=${state.sessionId} ops=${accepted.length}`);
        return true;
      }
      // 文件被其他写入者推进（或 proposal 不可重放）→ 回 started 走正常模型路径
      await this.options.store.updateRun({ idempotencyKey: record.idempotencyKey, status: 'started' });
      log?.warn(`consolidation prepared-recovery: CAS mismatch, rerunning model session=${state.sessionId}`);
      return false;
    } finally {
      await lock.release();
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
