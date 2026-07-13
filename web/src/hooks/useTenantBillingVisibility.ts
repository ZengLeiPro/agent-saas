import { useEffect, useState } from "react";

import { authFetch } from "@/lib/authFetch";

interface BillingVisibilitySummary {
  billingEnabled: boolean;
  billingMode: string;
}

interface BillingVisibilityState {
  tenantId: string;
  visible: boolean;
}

export function useTenantBillingVisibility(tenantId?: string | null): boolean | null {
  const [state, setState] = useState<BillingVisibilityState | null>(null);

  useEffect(() => {
    if (!tenantId) return;

    let cancelled = false;
    const load = async () => {
      try {
        const response = await authFetch("/api/billing/me/summary");
        if (!response.ok) throw new Error(`billing summary ${response.status}`);
        const data = await response.json() as { summary: BillingVisibilitySummary };
        if (!cancelled) {
          setState({
            tenantId,
            visible: data.summary.billingEnabled && data.summary.billingMode !== "internal",
          });
        }
      } catch {
        if (!cancelled) setState({ tenantId, visible: false });
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  if (!tenantId || state?.tenantId !== tenantId) return null;
  return state.visible;
}
