import { useCallback, useEffect, useRef, useState } from "react";

import { authFetch } from "@/lib/authFetch";
import { usageApi } from "@/components/UsageDashboard/api";
import type { ByModelResp, ByUserResp, OverviewStats, TrendResp } from "@/components/UsageDashboard/types";
import type { EfficiencyReport } from "@/components/RunTraceExplorer/types";

/** 综合分析页的时间参数：preset 走 range，自定义走 from/to（与 usage API 语义一致） */
export interface UsageDateArgs {
  range?: "today" | "7d" | "30d" | "mtd" | "all";
  from?: string;
  to?: string;
}

interface UsageBundleState {
  overview: OverviewStats | null;
  trend: TrendResp | null;
  byModel: ByModelResp | null;
  byUser: ByUserResp | null;
  loading: boolean;
  error: string | null;
}

const emptyState: UsageBundleState = {
  overview: null,
  trend: null,
  byModel: null,
  byUser: null,
  loading: false,
  error: null,
};

const DEFAULT_DATE_ARGS: UsageDateArgs = { range: "7d" };

export function useTenantUsageBundle(tenantId: string | undefined, dateArgs: UsageDateArgs = DEFAULT_DATE_ARGS) {
  const [state, setState] = useState<UsageBundleState>(emptyState);
  const requestIdRef = useRef(0);
  const { range, from, to } = dateArgs;

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!tenantId) {
      setState(emptyState);
      return;
    }

    // 切换组织/时间范围时先清空旧数据，避免请求期间短暂展示错误区间的旧值。
    setState({ ...emptyState, loading: true });
    try {
      const args = { range, from, to, tenantId };
      const [overview, trend, byModel, byUser] = await Promise.all([
        usageApi.overview(args),
        usageApi.trend(args),
        usageApi.byModel(args),
        usageApi.byUser(args),
      ]);
      if (requestId !== requestIdRef.current) return;
      setState({ overview, trend, byModel, byUser, loading: false, error: null });
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      setState(previous => ({
        ...previous,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [tenantId, range, from, to]);

  useEffect(() => {
    void refresh();
    return () => {
      requestIdRef.current += 1;
    };
  }, [refresh]);

  return { ...state, refresh };
}

// ────────── 运行健康（efficiency 聚合，后端锁本租户 + 成本按 policy 脱敏） ──────────

export interface TenantHealthState {
  report: EfficiencyReport | null;
  loading: boolean;
  /** 后端未挂载（file backend / billing 未启用）或无权限 → UI 整区隐藏 */
  unavailable: boolean;
  error: string | null;
}

export function useTenantHealth(tenantId: string | undefined, days: number): TenantHealthState & { refresh: () => Promise<void> } {
  const [state, setState] = useState<TenantHealthState>({ report: null, loading: false, unavailable: false, error: null });
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!tenantId) {
      setState({ report: null, loading: false, unavailable: false, error: null });
      return;
    }
    setState(previous => ({ ...previous, loading: true, error: null }));
    try {
      const sp = new URLSearchParams({ days: String(days), tenantId });
      const res = await authFetch(`/api/admin/runtime/trace/efficiency?${sp.toString()}`);
      if (requestId !== requestIdRef.current) return;
      if (res.status === 404 || res.status === 403) {
        setState({ report: null, loading: false, unavailable: true, error: null });
        return;
      }
      if (!res.ok) {
        setState({ report: null, loading: false, unavailable: false, error: `运行健康数据加载失败（${res.status}）` });
        return;
      }
      const report = (await res.json()) as EfficiencyReport;
      if (requestId !== requestIdRef.current) return;
      setState({ report, loading: false, unavailable: false, error: null });
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      setState({
        report: null,
        loading: false,
        unavailable: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [tenantId, days]);

  useEffect(() => {
    void refresh();
    return () => {
      requestIdRef.current += 1;
    };
  }, [refresh]);

  return { ...state, refresh };
}

// ────────── 积分账户（组织共享积分池：余额 + 本月消耗） ──────────

export interface TenantCreditsSummary {
  balanceCredits: number;
  reservedCredits: number;
  lowBalance: boolean;
  billingEnabled: boolean;
  currentMonthCreditsUsed: number;
}

export interface TenantCreditsState {
  summary: TenantCreditsSummary | null;
  loading: boolean;
  /** billing 未启用/未挂载 → 积分卡显示未启用 */
  unavailable: boolean;
}

export function useTenantCredits(tenantId: string | undefined): TenantCreditsState & { refresh: () => Promise<void> } {
  const [state, setState] = useState<TenantCreditsState>({ summary: null, loading: false, unavailable: false });
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!tenantId) {
      setState({ summary: null, loading: false, unavailable: false });
      return;
    }
    setState(previous => ({ ...previous, loading: true }));
    try {
      const res = await authFetch(`/api/admin/billing/accounts?tenantId=${encodeURIComponent(tenantId)}`);
      if (requestId !== requestIdRef.current) return;
      if (!res.ok) {
        setState({ summary: null, loading: false, unavailable: true });
        return;
      }
      const data = (await res.json()) as { summary?: TenantCreditsSummary };
      if (requestId !== requestIdRef.current) return;
      setState({ summary: data.summary ?? null, loading: false, unavailable: !data.summary });
    } catch {
      if (requestId !== requestIdRef.current) return;
      setState({ summary: null, loading: false, unavailable: true });
    }
  }, [tenantId]);

  useEffect(() => {
    void refresh();
    return () => {
      requestIdRef.current += 1;
    };
  }, [refresh]);

  return { ...state, refresh };
}
