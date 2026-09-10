import type { ReactNode } from "react";

import { TenantBillingPanel } from "@/components/BillingManager";
import {
  PAGE_TABS_LIST_CLASS,
  PAGE_TAB_TRIGGER_CLASS,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
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
      <TabsList className={PAGE_TABS_LIST_CLASS} aria-label="用量、预算与计费">
        <TabsTrigger value="usage" className={PAGE_TAB_TRIGGER_CLASS}>用量看板</TabsTrigger>
        <TabsTrigger value="billing" className={PAGE_TAB_TRIGGER_CLASS}>预算与计费</TabsTrigger>
      </TabsList>
      <TabsContent value="usage" className="mt-4">
        {usage}
      </TabsContent>
      <TabsContent value="billing" className="mt-4">
        <TenantBillingPanel tenantId={tenantId} tenantName={tenantName} />
      </TabsContent>
    </Tabs>
  );
}
