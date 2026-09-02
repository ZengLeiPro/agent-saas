import type { AgentTargetTransitionImpact } from '@agent/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export function AgentSwitchConfirmationDialog(props: {
  open: boolean;
  targetName: string;
  impacts: AgentTargetTransitionImpact[];
  cancelling: boolean;
  cancelError?: string;
  onKeepOldOpen: () => void;
  onCancelActive: () => void;
  onClose: () => void;
}) {
  const impactText = props.impacts.map(impact => {
    if (impact.kind === 'running') return `当前任务仍在${impact.liveness === 'waiting_interaction' ? '等待交互' : '运行'}`;
    if (impact.kind === 'queued') return `${impact.count} 条消息仍在排队`;
    return '有一项待处理交互';
  });
  return (
    <Dialog open={props.open} onOpenChange={(open) => { if (!open && !props.cancelling) props.onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>切换到 {props.targetName}？</DialogTitle>
          <DialogDescription>不同 Agent 必须开启新会话。当前会话不会改绑，草稿和附件会保留。</DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          {impactText.map(item => <li key={item}>{item}</li>)}
        </ul>
        {props.cancelError ? <p className="text-sm text-destructive">取消失败：{props.cancelError}</p> : null}
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" disabled={props.cancelling} onClick={props.onClose}>暂不切换</Button>
          <Button variant="secondary" disabled={props.cancelling} onClick={props.onKeepOldOpen}>保留旧会话运行并切换</Button>
          <Button disabled={props.cancelling} onClick={props.onCancelActive}>
            {props.cancelling ? '等待服务端确认取消…' : '取消进行中任务后切换'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
