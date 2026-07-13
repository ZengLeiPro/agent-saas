import { Bot } from "lucide-react";
import type { OrgAgentSummary } from "@agent/shared";

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
          <DialogTitle>选择专职 Agent</DialogTitle>
          <DialogDescription>
            当前组织未开放个人 Agent，请选择要发起新对话的公司专职 Agent。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {agents.length === 0 ? (
            <div className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
              暂无可用的公司专职 Agent，请联系组织管理员。
            </div>
          ) : agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              className="flex w-full items-center gap-3 rounded-lg border bg-card px-3 py-3 text-left transition-colors hover:bg-muted/60"
              onClick={() => onSelect(agent.id)}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-base dark:bg-brand-900/35" aria-hidden="true">
                {agent.avatar || <Bot className="h-4 w-4 text-brand-600" />}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{agent.name}</span>
                <span className="block text-xs text-muted-foreground">公司专职 Agent</span>
              </span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
