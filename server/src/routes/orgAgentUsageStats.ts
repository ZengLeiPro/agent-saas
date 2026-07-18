/**
 * 企业专家使用统计派生查询（2026-07-18 B2 蓝图 § 3.2.1）
 *
 * 无 DDL：从 sessionProjectionStore（meta_json->>'orgAgentId' partial index）
 * 与 runtime_guardrail_events（org_agent_id, created_at DESC）两张已有表派生 30 天 KPI。
 * 全部依赖 optional：PG 未装配时全部字段返回 null（前端 unavailable 隐藏卡片），不抛错。
 *
 * 注意（confidence 字段）：现有 runtime_guardrail_events 表**未存**门禁 confidence
 * 分数（`GuardrailCheckResult` 也没有该字段，门禁只输出三态 verdict）。所以 P50/P90
 * 目前只能返回 null。若未来产品要精确置信度分布，需先在 pgGuardrailEventStore 加
 * confidence 列 + 门禁 prompt 让模型回吐一个 0-1 分。本 MVP 不做，直接留 null。
 */

import type { GuardrailEventStore } from '../data/guardrail/pgGuardrailEventStore.js';
import type {
  PgSessionProjectionStore,
  RuntimeSessionProjectionRecord,
} from '../runtime/sessionProjectionStore.js';

/** projection 只需 list 能力（PG 实现天然满足；测试可注入内存实现） */
export type UsageStatsSessionReader = Pick<PgSessionProjectionStore, 'list'>;

export interface UsageStatsDeps {
  sessionProjectionStore?: UsageStatsSessionReader;
  guardrailEventStore?: GuardrailEventStore;
  /** 测试注入 Date.now 替身，默认 () => new Date() */
  now?: () => Date;
}

export interface OrgAgentUsageStatsResponse {
  orgAgentId: string;
  tenantId: string;
  windowDays: number;
  /** 被 @ 次数（近似：绑定该专家的会话数；每次新会话 = 一次调用入口） */
  mentionsCount: number;
  /** 门禁拒答次数（runtime_guardrail_events verdict='off_topic'） */
  gateRejectionsCount: number;
  /** 独立员工数（近似：会话 owner userId 去重） */
  activeUsersCount: number;
  /** 平均对话轮次（当前无消息级投影，返回 null；未来接入 messages 表后补齐） */
  avgSessionLength: number | null;
  /** 门禁 confidence P50 / P90（当前门禁只输出三态 verdict，未存 confidence，返回 null） */
  guardrailConfidenceP50: number | null;
  guardrailConfidenceP90: number | null;
}

const DEFAULT_WINDOW_DAYS = 30;

/**
 * 派生某企业专家在指定 tenant 下的 30 天 KPI。
 *
 * - sessionProjectionStore 缺 → mentions/activeUsers 0
 * - guardrailEventStore 缺 → gateRejections 0
 * - 二者都缺 → 全部 0（前端可据此判断"数据源未装配"）
 *
 * 不抛错：任一 store 查询失败被 catch 后按 0 处理，日志由调用方 route handler 记
 * （避免此 service 依赖 logger 实例）。
 */
export async function computeOrgAgentUsageStats(
  params: { orgAgentId: string; tenantId: string; windowDays?: number },
  deps: UsageStatsDeps,
): Promise<OrgAgentUsageStatsResponse> {
  const windowDays = Math.max(1, Math.min(365, params.windowDays ?? DEFAULT_WINDOW_DAYS));
  const now = (deps.now ?? (() => new Date()))();
  const fromIso = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const toIso = now.toISOString();

  const [sessionStats, gateRejectionsCount] = await Promise.all([
    computeSessionStats(deps.sessionProjectionStore, params, fromIso, toIso),
    computeGateRejections(deps.guardrailEventStore, params, fromIso, toIso),
  ]);

  return {
    orgAgentId: params.orgAgentId,
    tenantId: params.tenantId,
    windowDays,
    mentionsCount: sessionStats.mentionsCount,
    gateRejectionsCount,
    activeUsersCount: sessionStats.activeUsersCount,
    avgSessionLength: null,
    guardrailConfidenceP50: null,
    guardrailConfidenceP90: null,
  };
}

async function computeSessionStats(
  store: UsageStatsSessionReader | undefined,
  params: { orgAgentId: string; tenantId: string },
  fromIso: string,
  toIso: string,
): Promise<{ mentionsCount: number; activeUsersCount: number }> {
  if (!store) return { mentionsCount: 0, activeUsersCount: 0 };
  try {
    // 分页扫描窗口内该 orgAgent 的所有会话（限 500 页 * 100 = 5 万条硬顶；MVP 单专家远小于此）
    const collected: RuntimeSessionProjectionRecord[] = [];
    let cursor: { updatedAt: string; sessionId: string } | undefined;
    const PAGE = 100;
    const HARD_CAP_PAGES = 500;
    for (let i = 0; i < HARD_CAP_PAGES; i++) {
      const page = await store.list({
        tenantId: params.tenantId,
        orgAgentId: params.orgAgentId,
        updatedFrom: fromIso,
        updatedTo: toIso,
        kind: 'user',
        ...(cursor ? { cursor } : {}),
        limit: PAGE,
      });
      collected.push(...page.items);
      if (!page.nextCursor || page.items.length < PAGE) break;
      cursor = page.nextCursor;
    }
    const userIds = new Set<string>();
    for (const s of collected) {
      const uid = s.userId ?? s.username;
      if (uid) userIds.add(uid);
    }
    return { mentionsCount: collected.length, activeUsersCount: userIds.size };
  } catch {
    return { mentionsCount: 0, activeUsersCount: 0 };
  }
}

async function computeGateRejections(
  store: GuardrailEventStore | undefined,
  params: { orgAgentId: string; tenantId: string },
  fromIso: string,
  toIso: string,
): Promise<number> {
  if (!store) return 0;
  try {
    // 只取 total（limit=1 拿单页兜底 + total 字段是精确计数）
    const result = await store.list({
      tenantId: params.tenantId,
      orgAgentId: params.orgAgentId,
      verdict: 'off_topic',
      from: fromIso,
      to: toIso,
      limit: 1,
      offset: 0,
    });
    return result.total;
  } catch {
    return 0;
  }
}
