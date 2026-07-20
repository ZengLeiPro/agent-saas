import {
  BRAND_SEGMENTED_TABS_LIST_CLASS,
  BRAND_SEGMENTED_TAB_TRIGGER_CLASS,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

const CAPABILITY_TAB_TRIGGER_CLASS = cn(
  BRAND_SEGMENTED_TAB_TRIGGER_CLASS,
  "px-2 sm:px-3",
);

export function CapabilityTabsList({
  className,
  showTemplates = true,
}: {
  className?: string;
  showTemplates?: boolean;
}) {
  return (
    <TabsList className={cn(
      BRAND_SEGMENTED_TABS_LIST_CLASS,
      "grid",
      showTemplates ? "max-w-2xl grid-cols-4" : "max-w-xl grid-cols-3",
      className,
    )}>
      {showTemplates && (
        <TabsTrigger value="templates" className={CAPABILITY_TAB_TRIGGER_CLASS}>
          任务模板
        </TabsTrigger>
      )}
      <TabsTrigger value="experts" className={CAPABILITY_TAB_TRIGGER_CLASS}>
        专家
      </TabsTrigger>
      <TabsTrigger value="skills" className={CAPABILITY_TAB_TRIGGER_CLASS}>
        技能
      </TabsTrigger>
      <TabsTrigger value="connectors" className={CAPABILITY_TAB_TRIGGER_CLASS}>
        连接器
      </TabsTrigger>
    </TabsList>
  );
}
