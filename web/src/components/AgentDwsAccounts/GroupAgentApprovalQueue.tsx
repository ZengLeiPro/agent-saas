import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export interface GroupAgentApproval {
  approvalId: string;
  runId: string;
  conversationId: string;
  workConversationId: string;
  toolName: string;
  displayName?: string;
  input: unknown;
  createdAt: string;
}

export function GroupAgentApprovalQueue({
  approvals,
  busy,
  onDecision,
}: {
  approvals: GroupAgentApproval[];
  busy: string;
  onDecision(approval: GroupAgentApproval, decision: 'approved' | 'rejected'): void;
}) {
  if (!approvals.length) return null;
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="font-medium">待审批操作</h3>
        <Badge variant="warning">{approvals.length}</Badge>
      </div>
      {approvals.map((approval) => (
        <div key={approval.approvalId} className="space-y-2 rounded-lg border p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="muted">{approval.displayName || approval.toolName}</Badge>
            <span>来源群：{approval.conversationId}</span>
            <span className="text-xs text-muted-foreground">{approval.createdAt}</span>
          </div>
          <pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">
            {JSON.stringify(approval.input, null, 2)}
          </pre>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={Boolean(busy)}
              onClick={() => onDecision(approval, 'approved')}
            >
              批准执行
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={Boolean(busy)}
              onClick={() => onDecision(approval, 'rejected')}
            >
              拒绝
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}
