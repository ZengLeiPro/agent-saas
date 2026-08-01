import { useEffect, useState } from "react";

import { authFetch } from "@/lib/authFetch";

export interface TenantBillingSummary {
  balanceCredits: number;
  billingEnabled: boolean;
  billingMode: string;
}

interface BillingSummaryState {
  tenantId: string;
  summary: TenantBillingSummary;
}

const HIDDEN_BILLING_SUMMARY: TenantBillingSummary = {
  balanceCredits: 0,
  billingEnabled: false,
  billingMode: "internal",
};

export function useTenantBillingSummary(tenantId?: string | null): TenantBillingSummary | null {
  const [state, setState] = useState<BillingSummaryState | null>(null);

  useEffect(() => {
    if (!tenantId) return;

    let cancelled = false;
    const load = async () => {
      try {
        const response = await authFetch("/api/billing/me/summary");
        if (!response.ok) throw new Error(`billing summary ${response.status}`);
        const data = await response.json() as { summary: TenantBillingSummary };
        if (!cancelled) setState({ tenantId, summary: data.summary });
      } catch {
        if (!cancelled) setState({ tenantId, summary: HIDDEN_BILLING_SUMMARY });
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  if (!tenantId || state?.tenantId !== tenantId) return null;
  return state.summary;
}

export function useTenantBillingVisibility(tenantId?: string | null): boolean | null {
  const summary = useTenantBillingSummary(tenantId);
  if (!summary) return null;
  return summary.billingEnabled && summary.billingMode !== "internal";
}
