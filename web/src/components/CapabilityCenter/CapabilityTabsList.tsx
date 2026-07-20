import { EntityIcons } from "@/lib/icons";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export function CapabilityTabsList({
  className,
  showTemplates = true,
}: {
  className?: string;
  showTemplates?: boolean;
}) {
  return (
    <TabsList className={cn(
      "grid h-9 w-full bg-muted/60 p-1",
      showTemplates ? "max-w-2xl grid-cols-4" : "max-w-xl grid-cols-3",
      className,
    )}>
      {showTemplates && (
        <TabsTrigger value="templates" className="h-7 gap-1.5 py-0">
          <EntityIcons.taskTemplates className="size-4" />任务模板
        </TabsTrigger>
      )}
      <TabsTrigger value="experts" className="h-7 gap-1.5 py-0"><EntityIcons.expert className="size-4" />专家</TabsTrigger>
      <TabsTrigger value="skills" className="h-7 gap-1.5 py-0"><EntityIcons.skill className="size-4" />技能</TabsTrigger>
      <TabsTrigger value="connectors" className="h-7 gap-1.5 py-0"><EntityIcons.connector className="size-4" />连接器</TabsTrigger>
    </TabsList>
  );
}
