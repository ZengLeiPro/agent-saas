import { useCallback, useEffect, useRef, useState } from "react";

import { usageApi } from "@/components/UsageDashboard/api";
import type { ByModelResp, ByUserResp, OverviewStats, TrendResp } from "@/components/UsageDashboard/types";

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

export function useTenantUsageBundle(tenantId: string | undefined) {
  const [state, setState] = useState<UsageBundleState>(emptyState);
  const requestIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!tenantId) {
      setState(emptyState);
      return;
    }

    // 切换组织时先清空上一组织的数据，避免请求期间短暂展示跨组织旧值。
    setState({ ...emptyState, loading: true });
    try {
      const [overview, trend, byModel, byUser] = await Promise.all([
        usageApi.overview({ range: "7d", tenantId }),
        usageApi.trend({ range: "7d", tenantId }),
        usageApi.byModel({ range: "7d", tenantId }),
        usageApi.byUser({ range: "7d", tenantId }),
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
  }, [tenantId]);

  useEffect(() => {
    void refresh();
    return () => {
      requestIdRef.current += 1;
    };
  }, [refresh]);

  return { ...state, refresh };
}
