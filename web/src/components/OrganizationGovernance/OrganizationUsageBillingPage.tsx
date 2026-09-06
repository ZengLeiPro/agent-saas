import type { ReactNode } from "react";

import { TenantBillingPanel } from "@/components/BillingManager";
import { KyAppTenantUsagePanel } from "@/components/KyAppDeliveryPanels";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

  const changeSection = (next: string) => {
    const value = next as UsageSection;
    url.set(USAGE_SECTION_KEY, value === "usage" ? null : value, { history: "push" });
  };

  return (
    <Tabs value={section} onValueChange={changeSection} className="min-h-full w-full">
      <TabsList className="mb-4 h-9" aria-label="用量、预算与计费">
        <TabsTrigger value="usage">用量看板</TabsTrigger>
        <TabsTrigger value="billing">预算与计费</TabsTrigger>
      </TabsList>
      <TabsContent value="usage" className="mt-0">
        {usage}
      </TabsContent>
      <TabsContent value="billing" className="mt-0">
        <KyAppTenantUsagePanel tenantId={tenantId} />
        <TenantBillingPanel tenantId={tenantId} tenantName={tenantName} />
      </TabsContent>
    </Tabs>
  );
}
