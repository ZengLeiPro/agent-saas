/**
 * 并行感知的墙钟耗时：合并重叠区间后取并集长度。
 *
 * 业务步骤卡不能用 `getActivityDurationMs` 的朴素求和——工具/子代理重叠时会
 * 把并行墙钟算成串行累加。本模块只做区间并集；调用方负责从步骤节收集叶子。
 *
 * 数据形态（本仓库现状）：
 * - thinking：常有 `startedAt`，结束时补 `durationMs`；进行中只有 start
 * - tool_use / subagent：完成时多半只有 `durationMs`，没有 start 时间戳
 *
 * 因此：有 start 的叶子走区间并集；仅有 durationMs 的叶子走下方 fallback，
 * 并与有日期的并集相加（无法把无 start 的叶子放到绝对时间轴上，只能当作
 * 额外串行覆盖；这是当前数据下偏差最小的做法）。
 */
import type { MessageItem, RenderItem } from '../types/message';

export interface TimeInterval {
  startMs: number;
  endMs: number;
}

export type ActivityTimingLeaf = Pick<
  Extract<MessageItem, { type: 'thinking' | 'tool_use' | 'subagent' }>,
  'type' | 'durationMs'
> & {
  startedAt?: number;
  streaming?: boolean;
  executionStatus?: Extract<MessageItem, { type: 'tool_use' }>['executionStatus'];
  status?: Extract<MessageItem, { type: 'subagent' }>['status'];
  resultReady?: boolean;
};

/** 合并重叠/相接区间，返回并集总长度（ms）。非法或空输入返回 0。 */
export function mergeIntervalDurationMs(intervals: readonly TimeInterval[]): number {
  const normalized = intervals
    .filter(
      (interval) =>
        Number.isFinite(interval.startMs) &&
        Number.isFinite(interval.endMs) &&
        interval.endMs >= interval.startMs,
    )
    .map((interval) => ({ startMs: interval.startMs, endMs: interval.endMs }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  if (normalized.length === 0) return 0;

  let total = 0;
  let coverStart = normalized[0].startMs;
  let coverEnd = normalized[0].endMs;

  for (let i = 1; i < normalized.length; i++) {
    const next = normalized[i];
    if (next.startMs <= coverEnd) {
      if (next.endMs > coverEnd) coverEnd = next.endMs;
      continue;
    }
    total += coverEnd - coverStart;
    coverStart = next.startMs;
    coverEnd = next.endMs;
  }
  total += coverEnd - coverStart;
  return total;
}

/**
 * 从单条活动叶子推断墙钟区间。
 * - startedAt + durationMs → 闭区间
 * - startedAt 且仍在进行 → [startedAt, nowMs]
 * - 仅有 durationMs → null（交给 fallback）
 */
export function activityLeafInterval(leaf: ActivityTimingLeaf, nowMs: number): TimeInterval | null {
  if (typeof leaf.startedAt !== 'number' || !Number.isFinite(leaf.startedAt)) return null;

  if (
    typeof leaf.durationMs === 'number' &&
    Number.isFinite(leaf.durationMs) &&
    leaf.durationMs >= 0
  ) {
    return { startMs: leaf.startedAt, endMs: leaf.startedAt + leaf.durationMs };
  }

  if (isTimingLeafActive(leaf)) {
    if (!Number.isFinite(nowMs) || nowMs < leaf.startedAt) return null;
    return { startMs: leaf.startedAt, endMs: nowMs };
  }

  return null;
}

function isTimingLeafActive(leaf: ActivityTimingLeaf): boolean {
  if (leaf.type === 'thinking') return Boolean(leaf.streaming);
  if (leaf.type === 'subagent') return leaf.status === 'running';
  if (leaf.type === 'tool_use') {
    if (leaf.executionStatus === 'running' || leaf.streaming) return true;
    return (
      !leaf.resultReady &&
      leaf.executionStatus !== 'completed' &&
      leaf.executionStatus !== 'failed' &&
      leaf.executionStatus !== 'cancelled'
    );
  }
  return false;
}

/**
 * 无 start 时的 durationMs fallback。
 *
 * - 默认求和（主代理工具在同一步内通常串行）
 * - 若全部是 subagent 且 ≥2 条：取 max（扇出并行是常见结构；本仓库没有显式
 *   parallel 标记，只能用类型启发）
 */
export function orphanDurationFallbackMs(leaves: readonly ActivityTimingLeaf[]): number {
  const orphans = leaves.filter(
    (leaf) =>
      typeof leaf.durationMs === 'number' &&
      Number.isFinite(leaf.durationMs) &&
      leaf.durationMs >= 0 &&
      (typeof leaf.startedAt !== 'number' || !Number.isFinite(leaf.startedAt)),
  );
  if (orphans.length === 0) return 0;

  const allSubagents = orphans.every((leaf) => leaf.type === 'subagent');
  if (allSubagents && orphans.length >= 2) {
    return Math.max(...orphans.map((leaf) => leaf.durationMs as number));
  }
  return orphans.reduce((sum, leaf) => sum + (leaf.durationMs as number), 0);
}

/**
 * 叶子活动的墙钟耗时。无任何可用数据时返回 undefined（调用方隐藏耗时位）。
 */
export function activityWallClockDurationMs(
  leaves: readonly ActivityTimingLeaf[],
  options: { nowMs?: number } = {},
): number | undefined {
  const nowMs = options.nowMs ?? Date.now();
  const timedLeaves = leaves.filter(
    (leaf) => leaf.type === 'thinking' || leaf.type === 'tool_use' || leaf.type === 'subagent',
  );
  if (timedLeaves.length === 0) return undefined;

  const intervals: TimeInterval[] = [];
  for (const leaf of timedLeaves) {
    const interval = activityLeafInterval(leaf, nowMs);
    if (interval) intervals.push(interval);
  }

  const datedMs = intervals.length > 0 ? mergeIntervalDurationMs(intervals) : 0;
  const orphanMs = orphanDurationFallbackMs(timedLeaves);
  const total = datedMs + orphanMs;
  return total > 0 || intervals.length > 0 || orphanMs > 0 ? total : undefined;
}

/** 进行中叶子的最早 startedAt；没有则 undefined（UI 不展示 live 耗时）。 */
export function earliestLiveStartedAtMs(leaves: readonly ActivityTimingLeaf[]): number | undefined {
  let earliest: number | undefined;
  for (const leaf of leaves) {
    if (!isTimingLeafActive(leaf)) continue;
    if (typeof leaf.startedAt !== 'number' || !Number.isFinite(leaf.startedAt)) continue;
    if (earliest === undefined || leaf.startedAt < earliest) earliest = leaf.startedAt;
  }
  return earliest;
}

/** 从步骤节 / activity_group 递归收集 thinking|tool_use|subagent 叶子。 */
export function collectActivityTimingLeaves(items: readonly RenderItem[]): ActivityTimingLeaf[] {
  const leaves: ActivityTimingLeaf[] = [];
  for (const item of items) {
    if (item.type === 'activity_group') {
      leaves.push(...collectActivityTimingLeaves(item.items as RenderItem[]));
      continue;
    }
    if (item.type === 'business_step_section') {
      leaves.push(...collectActivityTimingLeaves(item.items));
      continue;
    }
    if (item.type === 'thinking' || item.type === 'tool_use' || item.type === 'subagent') {
      leaves.push(item);
    }
  }
  return leaves;
}
