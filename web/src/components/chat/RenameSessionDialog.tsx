import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";

interface RenameSessionDialogProps {
  open: boolean;
  initialTitle: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (newTitle: string) => Promise<boolean>;
  dialogTitle?: string;
  dialogDescription?: string;
  placeholder?: string;
}

export function RenameSessionDialog({
  open,
  initialTitle,
  onOpenChange,
  onConfirm,
  dialogTitle = "重命名会话",
  dialogDescription = "输入新的会话名称",
  placeholder = "会话名称",
}: RenameSessionDialogProps) {
  const [value, setValue] = useState("");
  const [renaming, setRenaming] = useState(false);
  const isComposingRef = useRef(false);

  // 弹窗打开时同步初始标题
  useEffect(() => {
    if (open) {
      setValue(initialTitle);
    }
  }, [open, initialTitle]);

  const handleConfirm = useCallback(async () => {
    const trimmed = value.trim();
    setRenaming(true);
    try {
      const ok = await onConfirm(trimmed);
      if (ok) {
        onOpenChange(false);
      }
    } finally {
      setRenaming(false);
    }
  }, [value, onConfirm, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!renaming) onOpenChange(o); }}>
      <DialogContent
        className="max-w-[calc(100vw-2rem)] sm:max-w-sm"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          const input = (e.target as HTMLElement).querySelector("input");
          if (input) {
            input.focus();
            input.select();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription>{dialogDescription}</DialogDescription>
        </DialogHeader>
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          disabled={renaming}
          onCompositionStart={() => { isComposingRef.current = true; }}
          onCompositionEnd={() => { setTimeout(() => { isComposingRef.current = false; }, 0); }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || isComposingRef.current) return;
            if (e.key === "Enter" && !renaming) {
              void handleConfirm();
            }
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={renaming}>
            取消
          </Button>
          <Button onClick={() => void handleConfirm()} disabled={renaming}>
            {renaming ? <Loader2 className="size-4 animate-spin" /> : null}
            确认
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
