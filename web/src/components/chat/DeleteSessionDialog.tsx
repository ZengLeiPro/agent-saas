import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface DeleteSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  isAdmin?: boolean;
  count?: number;
}

export function DeleteSessionDialog({
  open,
  onOpenChange,
  onConfirm,
  isAdmin,
  count = 1,
}: DeleteSessionDialogProps) {
  const isBatch = count > 1;
  const targetText = isBatch ? `这 ${count} 个会话` : "这个会话";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onConfirm(); } }}>
        <DialogHeader>
          <DialogTitle>{isAdmin ? "移至回收站" : "删除会话"}</DialogTitle>
          <DialogDescription>
            {isAdmin
              ? `确定要删除${targetText}吗？会话将移至回收站，可随时恢复。`
              : `确定要删除${targetText}吗？此操作不可恢复。`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            {isAdmin ? "移至回收站" : "删除"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
