import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface DeleteGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  isCron: boolean;
}

export function DeleteGroupDialog({
  open,
  onOpenChange,
  onConfirm,
  isCron,
}: DeleteGroupDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onConfirm(); } }}>
        <DialogHeader>
          <DialogTitle>删除分组</DialogTitle>
          <DialogDescription>
            确定要删除这个分组吗？分组内的会话不会被删除，将变为未分组状态。
            {isCron && "注意：此分组关联定时任务，下次任务执行时会自动重新创建。"}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
