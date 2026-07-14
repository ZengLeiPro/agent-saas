import { EntityIcons } from "@/lib/icons";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export function CapabilityTabsList({ className }: { className?: string }) {
  return (
    <TabsList className={cn("grid h-9 w-full max-w-xl grid-cols-3 bg-muted/60 p-1", className)}>
      <TabsTrigger value="experts" className="h-7 gap-1.5 py-0"><EntityIcons.expert className="size-4" />专家</TabsTrigger>
      <TabsTrigger value="skills" className="h-7 gap-1.5 py-0"><EntityIcons.skill className="size-4" />技能</TabsTrigger>
      <TabsTrigger value="connectors" className="h-7 gap-1.5 py-0"><EntityIcons.connector className="size-4" />连接器</TabsTrigger>
    </TabsList>
  );
}
