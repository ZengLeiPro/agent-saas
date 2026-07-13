/**
 * 自动上下文压缩（/compact v2，2026-07-03）
 *
 * 触发策略（三层）：
 * 1. post-run 主触发：正常 run 结束后评估「当前上下文 token / 模型窗口」，
 *    超阈值则以系统身份 enqueue 一条 content='/compact' 的 run——复用
 *    scheduler → wakeRuntimeSession → dispatch → loop.compact() 全链路，
 *    UI 分界线 / transcript / 事件流全部免费获得。
 * 2. 让路 + 抢占：
 *    - 让路：自动压缩 run 被 wake 时若该 session 已有更新的活跃 run
 *      （用户消息在排队），直接 cancelled 退出，不执行压缩。
 *    - 抢占：用户消息 dispatch 抢锁失败时，若持锁的是本进程的自动压缩 run，
 *      abort 它并短暂重试拿锁——用户消息永远第一优先级，压缩是可推迟的
 *      维护动作（compact 只在最后落 compaction 事件时才生效，中途 abort 无残留）。
 * 3. 防死循环：最后一条 compaction 事件晚于最后一条带 usage 的 assistant 事件
 *    时（刚压缩过、还没有新的模型轮），不触发；另有 enqueue 冷却兜底。
 *
 * 生效前提：租户 features.autoCompactEnabled=true 且模型配置了 context_window。
 */
import { randomUUID } from 'node:crypto';

import { getModelContextWindow } from '../data/usage/pricing.js';
import { createLogger } from '../utils/logger.js';
import { calculateCurrentContextTokens } from './contextAccounting.js';
import { runtimeRunController } from './runController.js';
import type { ExecutionTargetKind } from '../agent/toolRuntime.js';
import type { PlatformEvent } from './types.js';
import type { RunRecord, RunStore } from './runStore.js';

const logger = createLogger('AutoCompaction');

/** 触发阈值：当前上下文 ≥ contextWindow × 该比例。留 20% 余量给单次 run 增长。 */
export const AUTO_COMPACT_THRESHOLD_RATIO = 0.8;
/** enqueue 后冷却：期间不再评估该 session（防重复 enqueue）。 */
const ENQUEUE_COOLDOWN_MS = 5 * 60_000;
/** 抢占后等待锁释放的重试窗口。 */
const PREEMPT_LOCK_WAIT_MS = 10_000;
const PREEMPT_LOCK_RETRY_INTERVAL_MS = 250;

export interface AutoCompactionTenantSettingsReader {
  (tenantId: string | undefined): { autoCompactEnabled?: boolean } | undefined;
}

export interface AutoCompactionScheduleInput {
  sessionId: string;
  /** 刚结束的 run（评估来源，不是压缩 run） */
  finishedRunId: string;
  model: string;
  tenantId?: string;
  userId?: string;
  channel?: string;
  executionTarget?: ExecutionTargetKind;
  workspaceId?: string;
  cwd?: string;
  transcriptPath?: string;
  /** 该 session 的全量事件（调用方已持有 eventStore，list 后传入） */
  events: PlatformEvent[];
}

export interface AutoCompactionEvaluation {
  shouldCompact: boolean;
  reason: string;
  currentTokens?: number;
  contextWindow?: number;
}

/**
 * 纯判定逻辑（可单测）：从事件流估算当前上下文并与模型窗口比较。
 *
 * 当前上下文口径与 RuntimeContextUsageTracker 一致：全量请求以最后 leg 重锚；
 * Responses previous_response_id 接力按 (input-cache_read)+output 跨 leg 累加。
 */
export function evaluateAutoCompaction(input: {
  events: PlatformEvent[];
  model: string;
  autoCompactEnabled: boolean;
}): AutoCompactionEvaluation {
  if (!input.autoCompactEnabled) {
    return { shouldCompact: false, reason: 'tenant_disabled' };
  }
  const contextWindow = getModelContextWindow(input.model);
  if (!contextWindow) {
    return { shouldCompact: false, reason: 'no_context_window_configured' };
  }

  let lastUsageIndex = -1;
  let lastCompactionIndex = -1;
  for (let i = input.events.length - 1; i >= 0; i--) {
    const event = input.events[i]!;
    if (lastCompactionIndex < 0 && event.type === 'compaction') {
      lastCompactionIndex = i;
    }
    if (lastUsageIndex < 0
      && (event.type === 'assistant_message' || event.type === 'assistant_tool_calls')
      && event.usage) {
      lastUsageIndex = i;
    }
    if (lastUsageIndex >= 0 && lastCompactionIndex >= 0) break;
  }
  if (lastUsageIndex < 0) {
    return { shouldCompact: false, reason: 'no_usage_events', contextWindow };
  }
  // 防死循环：最后一次压缩之后还没有新的模型轮 → usage 反映的是压缩前的上下文，
  // 据其触发会无限重压。等下一轮真实交互后再评估。
  if (lastCompactionIndex > lastUsageIndex) {
    return { shouldCompact: false, reason: 'just_compacted', contextWindow };
  }
  const currentTokens = calculateCurrentContextTokens(input.events, input.model);
  if (currentTokens == null) {
    return { shouldCompact: false, reason: 'no_usage_events', contextWindow };
  }
  const threshold = Math.floor(contextWindow * AUTO_COMPACT_THRESHOLD_RATIO);
  if (currentTokens < threshold) {
    return { shouldCompact: false, reason: 'below_threshold', currentTokens, contextWindow };
  }
  return { shouldCompact: true, reason: 'threshold_exceeded', currentTokens, contextWindow };
}

export class AutoCompactionService {
  /** sessionId -> 进行中的自动压缩 runId（本进程内存态，抢占用） */
  private readonly activeRuns = new Map<string, string>();
  /** sessionId -> 冷却截止时间戳 */
  private readonly cooldownUntil = new Map<string, number>();

  constructor(private readonly deps: {
    runStore: RunStore;
    getTenantSettings: AutoCompactionTenantSettingsReader;
  }) {}

  /**
   * post-run 主触发入口。fire-and-forget：调用方 `void service.maybeScheduleAfterRun(...)`，
   * 内部吞错只打日志，绝不影响主 run 的出站流收尾。
   */
  async maybeScheduleAfterRun(input: AutoCompactionScheduleInput): Promise<void> {
    try {
      const now = Date.now();
      const cooldown = this.cooldownUntil.get(input.sessionId);
      if (cooldown && cooldown > now) return;

      const settings = this.deps.getTenantSettings(input.tenantId);
      const evaluation = evaluateAutoCompaction({
        events: input.events,
        model: input.model,
        autoCompactEnabled: settings?.autoCompactEnabled === true,
      });
      if (!evaluation.shouldCompact) {
        if (evaluation.reason !== 'tenant_disabled' && evaluation.reason !== 'below_threshold') {
          logger.debug(`[auto-compact] skip session=${input.sessionId} reason=${evaluation.reason}`);
        }
        return;
      }

      // 该 session 已有活跃 run（用户消息在排队/执行）→ 本次不压，下个 run 结束后再评估
      const active = await this.findOtherActiveRun(input.sessionId, input.finishedRunId);
      if (active) {
        logger.info(`[auto-compact] yield-before-enqueue session=${input.sessionId} activeRun=${active.runId}`);
        return;
      }

      const runId = `${Date.now()}-${randomUUID()}`;
      await this.deps.runStore.upsertPending({
        runId,
        sessionId: input.sessionId,
        userId: input.userId,
        tenantId: input.tenantId,
        model: input.model,
        channel: input.channel ?? 'web',
        executionTarget: input.executionTarget,
        workspaceId: input.workspaceId,
        metadata: {
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.transcriptPath ? { transcriptPath: input.transcriptPath } : {}),
          autoCompaction: true,
          wakeMessage: {
            channel: input.channel ?? 'web',
            chatId: input.sessionId,
            content: '/compact',
            attachments: [],
          },
        },
      });
      this.cooldownUntil.set(input.sessionId, now + ENQUEUE_COOLDOWN_MS);
      logger.info(
        `[auto-compact] enqueued session=${input.sessionId} run=${runId} `
        + `tokens=${evaluation.currentTokens}/${evaluation.contextWindow} model=${input.model}`,
      );
    } catch (err) {
      logger.warn(`[auto-compact] schedule failed session=${input.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 自动压缩 run 开始执行前的让路检查：session 里是否存在其他活跃 run。 */
  async shouldYield(sessionId: string, selfRunId: string): Promise<boolean> {
    const other = await this.findOtherActiveRun(sessionId, selfRunId);
    return !!other;
  }

  registerActive(sessionId: string, runId: string): void {
    this.activeRuns.set(sessionId, runId);
  }

  unregisterActive(sessionId: string, runId: string): void {
    if (this.activeRuns.get(sessionId) === runId) {
      this.activeRuns.delete(sessionId);
    }
  }

  /**
   * 用户消息抢占：若该 session 有本进程进行中的自动压缩 run，abort 它。
   * 返回是否发起了抢占（调用方据此决定是否重试拿锁）。
   */
  preempt(sessionId: string): boolean {
    const runId = this.activeRuns.get(sessionId);
    if (!runId) return false;
    const aborted = runtimeRunController.abort(runId);
    logger.info(`[auto-compact] preempted session=${sessionId} run=${runId} aborted=${aborted}`);
    return true;
  }

  private async findOtherActiveRun(sessionId: string, selfRunId: string): Promise<RunRecord | null> {
    const list = await this.deps.runStore.listBySession?.(sessionId, { limit: 10 });
    if (!list) {
      // runStore 不支持 listBySession（file/内存实现）→ 保守不让路
      return null;
    }
    const ACTIVE = new Set(['pending', 'running', 'waiting_approval', 'waiting_user', 'waiting_hand']);
    return list.find((run) => run.runId !== selfRunId && ACTIVE.has(run.status)) ?? null;
  }
}

/**
 * 抢占后等待锁释放的辅助：短间隔重试 tryAcquire，直到拿到或超时。
 */
export async function waitAcquireSessionLock<T>(
  tryAcquire: () => Promise<T | null>,
  timeoutMs: number = PREEMPT_LOCK_WAIT_MS,
  intervalMs: number = PREEMPT_LOCK_RETRY_INTERVAL_MS,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, intervalMs));
    const handle = await tryAcquire();
    if (handle) return handle;
  }
  return null;
}
