import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { CapabilityTab } from "./navigation";

const CAPABILITY_TABS: Array<{ value: CapabilityTab; label: string }> = [
  { value: "templates", label: "工作流" },
  { value: "skills", label: "技能" },
  { value: "connectors", label: "连接器" },
  { value: "experts", label: "专家" },
];

export function CapabilityTabsList({
  activeValue,
  className,
  showTemplates = true,
}: {
  activeValue: CapabilityTab;
  className?: string;
  showTemplates?: boolean;
}) {
  const tabs = showTemplates
    ? CAPABILITY_TABS
    : CAPABILITY_TABS.filter((tab) => tab.value !== "templates");
  return (
    <TabsList variant="primary" className={className} data-active-tab={activeValue}>
      {tabs.map((tab) => (
        <TabsTrigger
          key={tab.value}
          value={tab.value}
        >
          {tab.label}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}
