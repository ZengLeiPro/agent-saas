import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { authFetch } from "@/lib/authFetch";
import { usageApi } from "@/components/UsageDashboard/api";
import type { ByModelResp, ByUserResp, OverviewStats, TrendResp } from "@/components/UsageDashboard/types";
import type { EfficiencyReport } from "@/components/RunTraceExplorer/types";
import type { ModelList } from "@/types/models";

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

// ────────── 模型显示名映射（客户可见模型名） ──────────
// usage 数据里的 model 是底层真实 ID；客户界面按租户模型配置（含 displayOverrides）
// 映射为产品化显示名，映射不到时回退原 ID（历史模型/平台视角场景）。

export function useModelDisplayMap(): { labelFor: (modelId: string) => string } {
  const [map, setMap] = useState<Map<string, string> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await authFetch("/api/models");
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as ModelList;
        const next = new Map<string, string>();
        for (const group of data.groups ?? []) {
          for (const model of group.models ?? []) {
            if (!model?.id || !model.name) continue;
            next.set(model.id, model.name);
            next.set(`${group.id}/${model.id}`, model.name);
          }
        }
        if (!cancelled) setMap(next);
      } catch {
        // 静默失败：回退显示原 ID
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const labelFor = useCallback(
    (modelId: string) => map?.get(modelId) ?? modelId,
    [map],
  );

  return useMemo(() => ({ labelFor }), [labelFor]);
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

// ────────── 计费展示偏好（showBalance / showUsageCredits） ──────────
// 这是「客户侧显示偏好」而非安全边界（成本类脱敏由后端 fail-closed 负责），
// 因此加载失败时 fail-open 按默认全显示处理。

export interface TenantBillingDisplayPolicy {
  showBalance: boolean;
  showUsageCredits: boolean;
}

const DEFAULT_DISPLAY_POLICY: TenantBillingDisplayPolicy = { showBalance: true, showUsageCredits: true };

export function useTenantBillingDisplayPolicy(tenantId: string | undefined): TenantBillingDisplayPolicy {
  const [policy, setPolicy] = useState<TenantBillingDisplayPolicy>(DEFAULT_DISPLAY_POLICY);

  useEffect(() => {
    let cancelled = false;
    setPolicy(DEFAULT_DISPLAY_POLICY);
    if (!tenantId) return;
    void (async () => {
      try {
        const res = await authFetch(`/api/admin/billing/tenants/${encodeURIComponent(tenantId)}/policy`);
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { policy?: { showBalance?: boolean; showUsageCredits?: boolean } };
        if (cancelled || !data.policy) return;
        setPolicy({
          showBalance: data.policy.showBalance !== false,
          showUsageCredits: data.policy.showUsageCredits !== false,
        });
      } catch {
        // fail-open：保持默认全显示
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  return policy;
}

// ────────── 积分日消耗趋势（billing audit daily，近 N 天窗口） ──────────

export interface CreditTrendPoint {
  /** YYYY-MM-DD（北京时区） */
  date: string;
  /** 当日积分消耗 */
  credits: number;
}

export interface TenantCreditTrendState {
  points: CreditTrendPoint[];
  /** 窗口内积分消耗合计 */
  periodCredits: number;
  loading: boolean;
  unavailable: boolean;
}

const CREDIT_MICRO = 1_000_000;

/** 北京时区今天起往前 N 天的完整日期序列（asc），用于补齐无消耗日 */
function beijingDateWindow(days: number): string[] {
  const todayMs = Date.now() + 8 * 60 * 60 * 1000;
  const dates: string[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    dates.push(new Date(todayMs - offset * 86_400_000).toISOString().slice(0, 10));
  }
  return dates;
}

export function useTenantCreditTrend(
  tenantId: string | undefined,
  days: number,
  enabled: boolean,
): TenantCreditTrendState & { refresh: () => Promise<void> } {
  const [state, setState] = useState<TenantCreditTrendState>({ points: [], periodCredits: 0, loading: false, unavailable: false });
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!tenantId || !enabled) {
      setState({ points: [], periodCredits: 0, loading: false, unavailable: false });
      return;
    }
    setState(previous => ({ ...previous, loading: true }));
    try {
      const sp = new URLSearchParams({ days: String(days), tenantId });
      const res = await authFetch(`/api/admin/billing/audit?${sp.toString()}`);
      if (requestId !== requestIdRef.current) return;
      if (!res.ok) {
        setState({ points: [], periodCredits: 0, loading: false, unavailable: true });
        return;
      }
      const data = (await res.json()) as { audit?: { daily?: Array<{ date: string; creditsChargedMicro: number }> } };
      if (requestId !== requestIdRef.current) return;
      const byDate = new Map<string, number>();
      for (const point of data.audit?.daily ?? []) {
        byDate.set(point.date, (point.creditsChargedMicro ?? 0) / CREDIT_MICRO);
      }
      // 补齐窗口内无消耗日（daily 只返回有账目的日期）
      const points = beijingDateWindow(days).map(date => ({ date, credits: byDate.get(date) ?? 0 }));
      const periodCredits = points.reduce((sum, point) => sum + point.credits, 0);
      setState({ points, periodCredits, loading: false, unavailable: false });
    } catch {
      if (requestId !== requestIdRef.current) return;
      setState({ points: [], periodCredits: 0, loading: false, unavailable: true });
    }
  }, [tenantId, days, enabled]);

  useEffect(() => {
    void refresh();
    return () => {
      requestIdRef.current += 1;
    };
  }, [refresh]);

  return { ...state, refresh };
}
