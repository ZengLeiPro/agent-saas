import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/contexts/AuthContext";

const PHONE_PATTERN = /^1[3-9]\d{9}$/;

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
    <div
      className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4"
      style={{ paddingTop: "var(--sat)" }}
    >
      {/* 品牌色径向光晕背景：左上 brand-200 + 右下 brand-100，让登录页有"被品牌包裹"的氛围 */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-90"
        style={{
          background:
            "radial-gradient(60% 50% at 15% 10%, rgba(189, 204, 255, 0.55), transparent 70%), radial-gradient(50% 45% at 85% 90%, rgba(221, 229, 255, 0.6), transparent 70%)",
        }}
      />
      {/* 顶部品牌渐变 hairline */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-brand-600 to-transparent" />

      <Card className="relative w-full max-w-sm border-brand-100 shadow-brand backdrop-blur-sm">
        <CardContent className="pt-8 pb-6">
          {/* 品牌区：徽标 + 主标题 + 副标题，登录页第一印象 */}
          <div className="mb-6 flex flex-col items-center text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-500 to-brand-700 shadow-[0_6px_16px_-4px_rgba(46,86,225,0.5)]">
              <Sparkles className="h-6 w-6 text-white" strokeWidth={2.2} />
            </div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              KY Agent
            </h1>
            <p className="mt-1 text-xs text-muted-foreground">
              开沿科技 · AI 工作助手
            </p>
          </div>
          <form onSubmit={handleSubmit} className="space-y-4">
            <Tabs value={loginMode} onValueChange={(value) => { setLoginMode(value as "password" | "sms"); setError(""); }}>
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="password">密码登录</TabsTrigger>
                <TabsTrigger value="sms">验证码登录</TabsTrigger>
              </TabsList>
              <TabsContent value="password" className="mt-4 space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="username">用户名</Label>
                  <Input
                    id="username"
                    type="text"
                    autoComplete="username"
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
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required={loginMode === "password"}
                    disabled={loading}
                  />
                </div>
              </TabsContent>
              <TabsContent value="sms" className="mt-4 space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="sms-phone">手机号</Label>
                  <Input
                    id="sms-phone"
                    type="tel"
                    inputMode="numeric"
                    autoComplete="tel"
                    maxLength={11}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
                    required={loginMode === "sms"}
                    disabled={loading}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sms-code">验证码</Label>
                  <div className="flex gap-2">
                    <Input
                      id="sms-code"
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                      required={loginMode === "sms"}
                      disabled={loading}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      className="w-32 shrink-0"
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
            <Button type="submit" className="w-full" disabled={loading}>
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
                  className="ml-1 text-brand-600 hover:underline"
                  onClick={onSwitchToSignup}
                >
                  注册试用
                </button>
              </p>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
