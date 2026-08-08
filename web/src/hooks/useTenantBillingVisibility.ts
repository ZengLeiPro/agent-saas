import { useEffect, useState } from "react";

import { authFetch } from "@/lib/authFetch";

export interface TenantBillingSummary {
  balanceCredits: number;
  reservedCredits: number;
  billingEnabled: boolean;
  billingMode: string;
}

export interface MyMemberBudget {
  monthlyLimitCredits: number | null;
  remainingCredits: number | null;
}

export interface BillingAllowance {
  credits: number;
  source: "member" | "tenant";
}

interface BillingSummaryState {
  tenantId: string;
  summary: TenantBillingSummary;
}

interface MemberBudgetState {
  tenantId: string;
  budget: MyMemberBudget | null;
}

const HIDDEN_BILLING_SUMMARY: TenantBillingSummary = {
  balanceCredits: 0,
  reservedCredits: 0,
  billingEnabled: false,
  billingMode: "internal",
};

export function resolveBillingAllowance(
  summary: TenantBillingSummary,
  budget: MyMemberBudget | null,
): BillingAllowance {
  if (budget && budget.monthlyLimitCredits !== null && budget.remainingCredits !== null) {
    return { credits: budget.remainingCredits, source: "member" };
  }
  return { credits: summary.balanceCredits - summary.reservedCredits, source: "tenant" };
}

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

export function useMyMemberBudget(tenantId?: string | null): MyMemberBudget | null {
  const [state, setState] = useState<MemberBudgetState | null>(null);

  useEffect(() => {
    if (!tenantId) return;

    let cancelled = false;
    const load = async () => {
      try {
        const response = await authFetch("/api/billing/me/budget");
        if (!response.ok) throw new Error(`member budget ${response.status}`);
        const data = await response.json() as { budget: MyMemberBudget };
        if (!cancelled) setState({ tenantId, budget: data.budget });
      } catch {
        if (!cancelled) setState({ tenantId, budget: null });
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  if (!tenantId || state?.tenantId !== tenantId) return null;
  return state.budget;
}

export function useTenantBillingAllowance(tenantId?: string | null): {
  summary: TenantBillingSummary | null;
  allowance: BillingAllowance | null;
} {
  const summary = useTenantBillingSummary(tenantId);
  const budget = useMyMemberBudget(tenantId);
  const visible = summary?.billingEnabled === true && summary.billingMode !== "internal";
  return {
    summary,
    allowance: visible ? resolveBillingAllowance(summary, budget) : null,
  };
}

export function useTenantBillingVisibility(tenantId?: string | null): boolean | null {
  const summary = useTenantBillingSummary(tenantId);
  if (!summary) return null;
  return summary.billingEnabled && summary.billingMode !== "internal";
}
