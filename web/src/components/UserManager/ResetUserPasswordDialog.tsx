import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { UserInfo } from "./types";

interface ResetUserPasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: UserInfo | null;
  onConfirm: (id: string, password: string) => Promise<void>;
}

export function ResetUserPasswordDialog({
  open,
  onOpenChange,
  user,
  onConfirm,
}: ResetUserPasswordDialogProps) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setPassword("");
      setConfirmPassword("");
      setError("");
    }
  }, [open]);

  const handleConfirm = async () => {
    if (!user) return;
    if (password.length < 6) {
      setError("密码至少 6 位");
      return;
    }
    if (password !== confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }

    setError("");
    setLoading(true);
    try {
      await onConfirm(user.id, password);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "重置失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>重置密码</DialogTitle>
          <DialogDescription>
            为 <strong>{user?.realName || user?.username}</strong> 设置新密码。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="reset-user-new-password">新密码</Label>
            <Input
              id="reset-user-new-password"
              name="new-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              placeholder="请输入新密码（至少 6 位）"
              autoComplete="new-password"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="reset-user-confirm-password">确认新密码</Label>
            <Input
              id="reset-user-confirm-password"
              name="confirm-new-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              disabled={loading}
              placeholder="请再次输入新密码"
              autoComplete="new-password"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !loading) void handleConfirm();
              }}
            />
          </div>
          {error && (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              取消
            </Button>
            <Button onClick={handleConfirm} disabled={loading}>
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  重置中...
                </>
              ) : (
                "确认重置"
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
