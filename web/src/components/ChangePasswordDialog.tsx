import { useCallback, useState } from "react";
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
import { authFetch } from "@/lib/authFetch";

interface ChangePasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ChangePasswordDialog({ open, onOpenChange }: ChangePasswordDialogProps) {
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const reset = useCallback(() => {
    setOldPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setError("");
  }, []);

  const handleOpenChange = useCallback((o: boolean) => {
    if (submitting) return;
    if (!o) reset();
    onOpenChange(o);
  }, [submitting, reset, onOpenChange]);

  const handleSubmit = useCallback(async () => {
    setError("");
    if (!oldPassword) { setError("请输入当前密码"); return; }
    if (newPassword.length < 6) { setError("新密码至少 6 个字符"); return; }
    if (newPassword !== confirmPassword) { setError("两次输入的新密码不一致"); return; }

    setSubmitting(true);
    try {
      const res = await authFetch("/api/auth/password", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldPassword, newPassword }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError((data as { error?: string }).error || "修改失败");
        return;
      }
      reset();
      onOpenChange(false);
    } catch {
      setError("网络错误，请重试");
    } finally {
      setSubmitting(false);
    }
  }, [oldPassword, newPassword, confirmPassword, reset, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>修改密码</DialogTitle>
          <DialogDescription>请输入当前密码和新密码</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            id="change-current-password"
            name="current-password"
            type="password"
            autoComplete="current-password"
            placeholder="当前密码"
            value={oldPassword}
            onChange={(e) => setOldPassword(e.target.value)}
            disabled={submitting}
          />
          <Input
            id="change-new-password"
            name="new-password"
            type="password"
            autoComplete="new-password"
            placeholder="新密码（至少 6 位）"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={submitting}
          />
          <Input
            id="change-confirm-password"
            name="confirm-new-password"
            type="password"
            autoComplete="new-password"
            placeholder="确认新密码"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={submitting}
            onKeyDown={(e) => { if (e.key === "Enter" && !submitting) void handleSubmit(); }}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={submitting}>
            {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            确认修改
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
