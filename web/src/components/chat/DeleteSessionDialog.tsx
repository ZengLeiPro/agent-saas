import { useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface DeleteSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
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
  const [isDeleting, setIsDeleting] = useState(false);
  const deletingRef = useRef(false);
  const confirm = async () => {
    if (deletingRef.current) return;
    deletingRef.current = true;
    setIsDeleting(true);
    try {
      await onConfirm();
    } finally {
      deletingRef.current = false;
      setIsDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!deletingRef.current) onOpenChange(nextOpen); }}>
      <DialogContent onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void confirm(); } }}>
        <DialogHeader>
          <DialogTitle>{isAdmin ? "移至回收站" : "删除会话"}</DialogTitle>
          <DialogDescription>
            {isAdmin
              ? `确定要删除${targetText}吗？会话将移至回收站，可随时恢复。`
              : `确定要删除${targetText}吗？此操作不可恢复。`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" disabled={isDeleting} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="destructive" disabled={isDeleting} onClick={() => { void confirm(); }}>
            {isDeleting ? "删除中…" : isAdmin ? "移至回收站" : "删除"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
