import type { ReactNode } from "react";

import { TenantBillingPanel } from "@/components/BillingManager";
import { useAdminUrlQuery } from "@/hooks/useAdminUrlQuery";

const USAGE_SECTION_KEY = "usageSection";

type UsageSection = "usage" | "billing";

export function OrganizationUsageBillingPage({
  tenantId,
  tenantName,
  usage,
}: {
  tenantId: string;
  tenantName?: string;
  usage: ReactNode;
}) {
  const url = useAdminUrlQuery();
  const section: UsageSection = url.get(USAGE_SECTION_KEY) === "billing" ? "billing" : "usage";

  return section === "billing"
    ? <TenantBillingPanel tenantId={tenantId} tenantName={tenantName} />
    : <>{usage}</>;
}
