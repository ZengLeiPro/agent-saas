import { apiUrl } from "../lib/apiBase";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const PHONE_PATTERN = /^1[3-9]\d{9}$/;

interface AddAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddAccountDialog({ open, onOpenChange }: AddAccountDialogProps) {
  const { login, loginWithSms } = useAuth();
  const [loginMode, setLoginMode] = useState<"password" | "sms">("password");
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    if (!open) return;
    setLoginMode("password");
    setAccount("");
    setPassword("");
    setCode("");
    setError("");
    setLoading(false);
    setCountdown(0);
  }, [open]);

  useEffect(() => () => clearInterval(timerRef.current), []);

  const startCountdown = () => {
    clearInterval(timerRef.current);
    setCountdown(60);
    timerRef.current = setInterval(() => {
      setCountdown((value) => {
        if (value <= 1) {
          clearInterval(timerRef.current);
          return 0;
        }
        return value - 1;
      });
    }, 1000);
  };

  const handleSendCode = async () => {
    if (!PHONE_PATTERN.test(account)) {
      setError("请输入有效的 11 位手机号");
      return;
    }
    setError("");
    setSendingCode(true);
    try {
      const res = await fetch(apiUrl("/api/auth/sms/send-code"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: account }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(data.error || "验证码发送失败");
      startCountdown();
    } catch (err) {
      setError(err instanceof Error ? err.message : "验证码发送失败");
    } finally {
      setSendingCode(false);
    }
  };

  const handleLogin = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (loginMode === "sms" && !PHONE_PATTERN.test(account)) {
      setError("请输入有效的 11 位手机号");
      return;
    }
    setLoading(true);
    try {
      if (loginMode === "password") await login({ username: account, password });
      else await loginWithSms({ phone: account, code });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader className="text-center sm:text-center">
          <DialogTitle className="text-2xl">登录</DialogTitle>
          <DialogDescription>登录后会把账号添加到此设备，可随时快速切换。</DialogDescription>
        </DialogHeader>

          <form onSubmit={handleLogin} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="add-account-login-account">账号</Label>
              <Input
                id="add-account-login-account"
                inputMode={loginMode === "sms" ? "numeric" : "text"}
                autoComplete="username"
                placeholder="请输入手机号或用户名"
                value={account}
                onChange={(event) => setAccount(event.target.value)}
                required
                disabled={loading}
              />
            </div>
            {loginMode === "password" ? (
              <div className="space-y-2">
                <Label htmlFor="add-account-password">密码</Label>
                <Input
                  id="add-account-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  disabled={loading}
                />
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="add-account-code">验证码</Label>
                <div className="flex gap-2">
                  <Input
                    id="add-account-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={code}
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
                    required
                    disabled={loading}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="w-32 shrink-0"
                    onClick={handleSendCode}
                    disabled={sendingCode || countdown > 0 || loading}
                  >
                    {sendingCode ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : countdown > 0 ? (
                      `${countdown}s 后重发`
                    ) : (
                      "获取验证码"
                    )}
                  </Button>
                </div>
              </div>
            )}
            {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? <><Loader2 className="size-4 animate-spin" />登录中...</> : "继续"}
            </Button>
            <button
              type="button"
              className="block w-full text-center text-sm font-medium text-brand-600 hover:underline"
              onClick={() => {
                setLoginMode((mode) => (mode === "password" ? "sms" : "password"));
                setError("");
              }}
              disabled={loading}
            >
              {loginMode === "password" ? "使用短信验证码登录" : "使用密码登录"}
            </button>
          </form>
      </DialogContent>
    </Dialog>
  );
}
