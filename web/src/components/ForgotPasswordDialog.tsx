import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import { apiUrl } from "@/lib/apiBase";
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
const PHONE_PATTERN = /^1[3-9]\d{9}$/;
const INPUT_CLASS = "h-11 rounded-[10px]";
const CODE_BUTTON_CLASS =
  "h-11 w-28 shrink-0 rounded-[10px] border-brand-200 bg-brand-50 text-[13px] font-medium text-brand-700 hover:bg-brand-100 hover:text-brand-700";

interface ForgotPasswordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialPhone?: string;
  onSuccess: () => void;
}

async function post(path: string, body: unknown): Promise<void> {
  const response = await fetch(apiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || "操作失败，请稍后再试");
  }
}

export function ForgotPasswordDialog({
  open,
  onOpenChange,
  initialPhone = "",
  onSuccess,
}: ForgotPasswordDialogProps) {
  const [phone, setPhone] = useState(initialPhone);
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [sendingCode, setSendingCode] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    if (!open) return;
    setPhone(PHONE_PATTERN.test(initialPhone) ? initialPhone : "");
    setCode("");
    setNewPassword("");
    setConfirmPassword("");
    setError("");
    setCountdown(0);
    clearInterval(timerRef.current);
  }, [initialPhone, open]);

  useEffect(() => () => clearInterval(timerRef.current), []);

  const sendCode = async () => {
    if (!PHONE_PATTERN.test(phone)) {
      setError("请输入已绑定并验证的 11 位手机号");
      return;
    }
    setError("");
    setSendingCode(true);
    try {
      await post("/api/auth/password/reset/send-code", { phone });
      setCountdown(60);
      clearInterval(timerRef.current);
      timerRef.current = setInterval(() => {
        setCountdown((value) => {
          if (value <= 1) {
            clearInterval(timerRef.current);
            return 0;
          }
          return value - 1;
        });
      }, 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "验证码发送失败");
    } finally {
      setSendingCode(false);
    }
  };

  const resetPassword = async () => {
    if (!PHONE_PATTERN.test(phone)) {
      setError("请输入已绑定并验证的 11 位手机号");
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      setError("请输入 6 位验证码");
      return;
    }
    if (newPassword.length < 6) {
      setError("新密码至少 6 个字符");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("两次输入的新密码不一致");
      return;
    }
    setError("");
    setSubmitting(true);
    try {
      await post("/api/auth/password/reset", { phone, code, newPassword });
      onOpenChange(false);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "密码重置失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>找回密码</DialogTitle>
          <DialogDescription>
            使用账号已绑定并验证的手机号设置新密码。未绑定手机号请联系管理员重置。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="reset-phone">手机号</Label>
            <Input
              id="reset-phone"
              type="tel"
              inputMode="numeric"
              autoComplete="tel"
              className={INPUT_CLASS}
              value={phone}
              onChange={(event) => setPhone(event.target.value.replace(/\D/g, "").slice(0, 11))}
              placeholder="请输入已绑定手机号"
              disabled={submitting}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="reset-code">验证码</Label>
            <div className="flex gap-2.5">
              <Input
                id="reset-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                className={INPUT_CLASS}
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
                placeholder="6 位验证码"
                disabled={submitting}
              />
              <Button
                type="button"
                variant="outline"
                className={CODE_BUTTON_CLASS}
                onClick={sendCode}
                disabled={sendingCode || submitting || countdown > 0}
              >
                {sendingCode ? <Loader2 className="size-4 animate-spin" /> : countdown > 0 ? `${countdown}s 后重发` : "获取验证码"}
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="reset-new-password">新密码</Label>
            <Input
              id="reset-new-password"
              type="password"
              autoComplete="new-password"
              className={INPUT_CLASS}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              placeholder="至少 6 个字符"
              disabled={submitting}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="reset-confirm-password">确认新密码</Label>
            <Input
              id="reset-confirm-password"
              type="password"
              autoComplete="new-password"
              className={INPUT_CLASS}
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              placeholder="请再次输入新密码"
              disabled={submitting}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !submitting) void resetPassword();
              }}
            />
          </div>
          {error && (
            <div role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              取消
            </Button>
            <Button type="button" onClick={resetPassword} disabled={submitting}>
              {submitting ? <><Loader2 className="size-4 animate-spin" />重置中...</> : "重置密码"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
