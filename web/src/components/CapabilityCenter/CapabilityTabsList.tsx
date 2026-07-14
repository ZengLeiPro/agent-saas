import { Building2, Plug, Puzzle } from "lucide-react";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export function CapabilityTabsList({ className }: { className?: string }) {
  return (
    <TabsList className={cn("grid h-9 w-full max-w-xl grid-cols-3 bg-muted/60 p-1", className)}>
      <TabsTrigger value="experts" className="h-7 gap-1.5 py-0"><Building2 className="h-4 w-4" />专家</TabsTrigger>
      <TabsTrigger value="skills" className="h-7 gap-1.5 py-0"><Puzzle className="h-4 w-4" />技能</TabsTrigger>
      <TabsTrigger value="connectors" className="h-7 gap-1.5 py-0"><Plug className="h-4 w-4" />连接器</TabsTrigger>
    </TabsList>
  );
}
