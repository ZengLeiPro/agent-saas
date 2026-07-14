import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AuthShell } from "@/components/AuthShell";
import { useAuth } from "@/contexts/AuthContext";

const PHONE_PATTERN = /^1[3-9]\d{9}$/;

/** 门面统一样式（与 AuthShell/SignupPage 对齐，设计稿 B1「浅色光晕」） */
export const AUTH_INPUT_CLASS = "h-11 rounded-[10px]";
export const AUTH_SUBMIT_CLASS =
  "h-[46px] w-full rounded-[11px] bg-gradient-to-b from-brand-500 to-brand-600 text-[15px] font-semibold tracking-[0.14em] text-primary-foreground shadow-[0_8px_18px_-4px_rgba(46,86,225,0.45)] hover:brightness-105 hover:shadow-[0_10px_22px_-4px_rgba(46,86,225,0.55)] active:translate-y-px";
export const AUTH_CODE_BTN_CLASS =
  "h-11 w-28 shrink-0 rounded-[10px] border-brand-200 bg-brand-50 text-[13px] font-medium text-brand-700 hover:bg-brand-100 hover:text-brand-700";
export const AUTH_TAB_CLASS =
  "rounded-[9px] data-[state=active]:font-semibold data-[state=active]:text-brand-700 data-[state=active]:shadow-[0_2px_8px_rgba(46,86,225,0.14)]";

interface LoginPageProps {
  /** 切到注册页（AuthGate 提供；注册入口仅在后端开放自助注册时显示） */
  onSwitchToSignup?: () => void;
}

export function LoginPage({ onSwitchToSignup }: LoginPageProps) {
  const { login, loginWithSms } = useAuth();
  const [loginMode, setLoginMode] = useState<"password" | "sms">("password");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [signupEnabled, setSignupEnabled] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    if (!onSwitchToSignup) return;
    fetch("/api/signup/status")
      .then((res) => res.json())
      .then((data: { enabled?: boolean }) => setSignupEnabled(data.enabled === true))
      .catch(() => {});
  }, [onSwitchToSignup]);

  useEffect(() => () => clearInterval(timerRef.current), []);

  const startCountdown = () => {
    clearInterval(timerRef.current);
    setCountdown(60);
    timerRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timerRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const handleSendSmsCode = async () => {
    if (!PHONE_PATTERN.test(phone)) {
      setError("请输入有效的 11 位手机号");
      return;
    }
    setError("");
    setSendingCode(true);
    try {
      const res = await fetch("/api/auth/sms/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || "验证码发送失败");
      startCountdown();
    } catch (err) {
      setError(err instanceof Error ? err.message : "验证码发送失败");
    } finally {
      setSendingCode(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (loginMode === "sms" && !PHONE_PATTERN.test(phone)) {
      setError("请输入有效的 11 位手机号");
      return;
    }
    setLoading(true);
    try {
      if (loginMode === "password") {
        await login({ username, password });
      } else {
        await loginWithSms({ phone, code });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Tabs value={loginMode} onValueChange={(value) => { setLoginMode(value as "password" | "sms"); setError(""); }}>
          <TabsList className="grid h-11 w-full grid-cols-2 rounded-xl bg-brand-50 p-1">
            <TabsTrigger value="password" className={AUTH_TAB_CLASS}>
              密码登录
            </TabsTrigger>
            <TabsTrigger value="sms" className={AUTH_TAB_CLASS}>
              验证码登录
            </TabsTrigger>
          </TabsList>
          <TabsContent value="password" className="mt-5 space-y-[18px]">
            <div className="space-y-2">
              <Label htmlFor="username">用户名</Label>
              <Input
                id="username"
                type="text"
                autoComplete="username"
                placeholder="请输入用户名"
                className={AUTH_INPUT_CLASS}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required={loginMode === "password"}
                disabled={loading}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">密码</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                placeholder="请输入密码"
                className={AUTH_INPUT_CLASS}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required={loginMode === "password"}
                disabled={loading}
              />
            </div>
          </TabsContent>
          <TabsContent value="sms" className="mt-5 space-y-[18px]">
            <div className="space-y-2">
              <Label htmlFor="sms-phone">手机号</Label>
              <Input
                id="sms-phone"
                type="tel"
                inputMode="numeric"
                autoComplete="tel"
                maxLength={11}
                placeholder="请输入 11 位手机号"
                className={AUTH_INPUT_CLASS}
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
                required={loginMode === "sms"}
                disabled={loading}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sms-code">验证码</Label>
              <div className="flex gap-2.5">
                <Input
                  id="sms-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="6 位验证码"
                  className={AUTH_INPUT_CLASS}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  required={loginMode === "sms"}
                  disabled={loading}
                />
                <Button
                  type="button"
                  variant="outline"
                  className={AUTH_CODE_BTN_CLASS}
                  onClick={handleSendSmsCode}
                  disabled={sendingCode || countdown > 0 || loading}
                >
                  {sendingCode ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : countdown > 0 ? (
                    `${countdown}s 后重发`
                  ) : (
                    "获取验证码"
                  )}
                </Button>
              </div>
            </div>
          </TabsContent>
        </Tabs>
        {error && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
        <Button type="submit" className={AUTH_SUBMIT_CLASS} disabled={loading}>
          {loading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              登录中...
            </>
          ) : (
            loginMode === "password" ? "登录" : "验证码登录"
          )}
        </Button>
        {signupEnabled && onSwitchToSignup && (
          <p className="text-center text-xs text-muted-foreground">
            还没有账号？
            <button
              type="button"
              className="ml-1 font-medium text-brand-600 hover:underline"
              onClick={onSwitchToSignup}
            >
              注册试用
            </button>
          </p>
        )}
      </form>
    </AuthShell>
  );
}
