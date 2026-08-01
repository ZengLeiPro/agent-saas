import {
  BRAND_SEGMENTED_TABS_LIST_CLASS,
  BRAND_SEGMENTED_TAB_TRIGGER_CLASS,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { CapabilityTab } from "./navigation";

const CAPABILITY_TABS: Array<{ value: CapabilityTab; label: string }> = [
  { value: "templates", label: "工作流" },
  { value: "skills", label: "技能" },
  { value: "connectors", label: "连接器" },
  { value: "experts", label: "专家" },
];

const CAPABILITY_TAB_TRIGGER_CLASS = cn(
  BRAND_SEGMENTED_TAB_TRIGGER_CLASS,
  "relative z-10 px-2 sm:px-3",
);

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
  const activeIndex = Math.max(0, tabs.findIndex((tab) => tab.value === activeValue));

  return (
    <TabsList className={cn(
      BRAND_SEGMENTED_TABS_LIST_CLASS,
      "relative grid",
      showTemplates ? "max-w-2xl grid-cols-4" : "max-w-xl grid-cols-3",
      className,
    )}>
      <span
        aria-hidden="true"
        data-capability-tab-indicator
        className="pointer-events-none absolute inset-y-1 left-1 rounded-[7px] bg-background shadow-[0_1px_4px_rgba(15,23,42,0.10)] transition-transform duration-300 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
        style={{
          width: `calc((100% - 0.5rem) / ${tabs.length})`,
          transform: `translateX(${activeIndex * 100}%)`,
        }}
      />
      {tabs.map((tab) => (
        <TabsTrigger
          key={tab.value}
          value={tab.value}
          className={CAPABILITY_TAB_TRIGGER_CLASS}
        >
          {tab.label}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}
