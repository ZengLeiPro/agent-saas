import type { OrgAgentSummary } from "@agent/shared";
import { OrgAgentAvatarContent } from "@/components/OrgAgentAvatar";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface OrgAgentPickerDialogProps {
  open: boolean;
  agents: OrgAgentSummary[];
  onOpenChange: (open: boolean) => void;
  onSelect: (agentId: string) => void;
}

export function OrgAgentPickerDialog({
  open,
  agents,
  onOpenChange,
  onSelect,
}: OrgAgentPickerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>选择企业专家</DialogTitle>
          <DialogDescription>
            当前组织未开放个人通用 Agent，请选择要开始对话的企业专家。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {agents.length === 0 ? (
            <div className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
              暂无可用的企业专家，请联系组织管理员。
            </div>
          ) : agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              className="flex w-full items-center gap-3 rounded-lg border bg-card px-3 py-3 text-left transition-colors hover:bg-muted/60"
              onClick={() => onSelect(agent.id)}
            >
              <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand-50 text-base dark:bg-brand-900/35" aria-hidden="true">
                <OrgAgentAvatarContent agent={agent} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{agent.name}</span>
                <span className="mt-0.5 block line-clamp-2 text-xs text-muted-foreground">
                  {agent.description || "由组织统一配置的企业专家"}
                </span>
              </span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
