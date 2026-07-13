import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TOKEN_KEY } from "@/lib/constants";
import { ROLE_POSITION_OPTIONS } from "@/lib/roleOptions";

const PHONE_PATTERN = /^1[3-9]\d{9}$/;

/** 从当前 URL 收集 utm_* 参数（官网 CTA 带过来），随注册请求送后端推线索群 */
function collectUtm(): Record<string, string> | undefined {
  const params = new URLSearchParams(window.location.search);
  const utm: Record<string, string> = {};
  for (const [k, v] of params) {
    if (k.startsWith("utm_")) utm[k] = v;
  }
  return Object.keys(utm).length > 0 ? utm : undefined;
}

/** 场景直达：官网场景页 CTA 带来的场景库 id，注册成功后落地该场景（预填起手指令） */
function collectScenario(): string | undefined {
  const value = new URLSearchParams(window.location.search).get("scenario");
  return value && /^[a-z0-9-]{1,64}$/.test(value) ? value : undefined;
}

interface SignupPageProps {
  onSwitchToLogin: () => void;
}

/**
 * 留资兜底表单：注册未开放时的 waitlist、以及收不到验证码时的人工开通通道。
 * 提交到 /api/signup/waitlist（推钉钉线索群，由开通专员回联）。
 */
function WaitlistForm({
  description,
  utm,
  onSwitchToLogin,
}: {
  description: string;
  utm?: Record<string, string>;
  onSwitchToLogin: () => void;
}) {
  const [phone, setPhone] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!PHONE_PATTERN.test(phone)) {
      setError("请输入有效的 11 位手机号");
      return;
    }
    setError("");
    setSubmitting(true);
    try {
      const res = await fetch("/api/signup/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, utm }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || "提交失败，请稍后再试");
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "提交失败，请稍后再试");
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div className="space-y-4 text-center">
        <p className="text-sm text-foreground">已收到您的手机号。</p>
        <p className="text-sm text-muted-foreground">
          开通专员会尽快联系您，为您开通试用账号。
        </p>
        <Button variant="outline" className="w-full" onClick={onSwitchToLogin}>
          返回登录
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <p className="text-sm text-muted-foreground">{description}</p>
      <div className="space-y-2">
        <Label htmlFor="waitlist-phone">手机号</Label>
        <Input
          id="waitlist-phone"
          type="tel"
          inputMode="numeric"
          autoComplete="tel"
          maxLength={11}
          value={phone}
          onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
          required
          disabled={submitting}
        />
      </div>
      {error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            提交中...
          </>
        ) : (
          "留下手机号，等专员联系"
        )}
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        已有账号？
        <button
          type="button"
          className="ml-1 text-brand-600 hover:underline"
          onClick={onSwitchToLogin}
        >
          去登录
        </button>
      </p>
    </form>
  );
}

export function SignupPage({ onSwitchToLogin }: SignupPageProps) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [position, setPosition] = useState("");
  const [company, setCompany] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [countdown, setCountdown] = useState(0);
  /** 发码失败过 → 展示「收不到验证码」的留资兜底入口（移动号段短信未通的过渡） */
  const [sendFailed, setSendFailed] = useState(false);
  /** 发过码（移动号失败是异步回执，API 成功≠收到；倒计时走完仍未注册时也给兜底） */
  const [sentOnce, setSentOnce] = useState(false);
  const [showWaitlist, setShowWaitlist] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval>>();

  const utm = useMemo(collectUtm, []);
  const scenario = useMemo(collectScenario, []);

  useEffect(() => {
    fetch("/api/signup/status")
      .then((res) => res.json())
      .then((data: { enabled?: boolean }) => setEnabled(data.enabled === true))
      .catch(() => setEnabled(false));
    return () => clearInterval(timerRef.current);
  }, []);

  const startCountdown = () => {
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

  const handleSendCode = async () => {
    if (!PHONE_PATTERN.test(phone)) {
      setError("请输入有效的 11 位手机号");
      return;
    }
    setError("");
    setSending(true);
    try {
      const res = await fetch("/api/signup/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error || "验证码发送失败");
      setSentOnce(true);
      startCountdown();
    } catch (err) {
      setError(err instanceof Error ? err.message : "验证码发送失败");
      setSendFailed(true);
    } finally {
      setSending(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!position) {
      setError("请选择岗位");
      return;
    }
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/signup/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone,
          code,
          password,
          name,
          position,
          company: company || undefined,
          utm,
          scenario,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        token?: string;
        error?: string;
      };
      if (!res.ok || !data.token) throw new Error(data.error || "注册失败");
      // 与登录同构：写 token 后整页跳转回根路径（顺带清掉 /signup 与 utm 参数），
      // AuthContext 初始化时从 token 恢复登录态，直接进产品。
      // 场景直达：保留 scenario 参数，落地后由 useScenarioDeepLink 预填该场景起手指令。
      localStorage.setItem(TOKEN_KEY, data.token);
      window.location.replace(scenario ? `/?scenario=${scenario}` : "/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "注册失败");
      setLoading(false);
    }
  };

  return (
    <div
      className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-8"
      style={{ paddingTop: "var(--sat)" }}
    >
      {/* 与 LoginPage 一致的品牌氛围背景 */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-90"
        style={{
          background:
            "radial-gradient(60% 50% at 15% 10%, rgba(189, 204, 255, 0.55), transparent 70%), radial-gradient(50% 45% at 85% 90%, rgba(221, 229, 255, 0.6), transparent 70%)",
        }}
      />
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-brand-600 to-transparent" />

      <Card className="relative w-full max-w-sm border-brand-100 shadow-brand backdrop-blur-sm">
        <CardContent className="pt-8 pb-6">
          <div className="mb-6 flex flex-col items-center text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-brand-500 to-brand-700 shadow-[0_6px_16px_-4px_rgba(46,86,225,0.5)]">
              <Sparkles className="h-6 w-6 text-white" />
            </div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              注册试用 KY Agent
            </h1>
            <p className="mt-1 text-xs text-muted-foreground">
              开沿科技 · 每个岗位，一个 AI 同事
            </p>
          </div>

          {enabled === null ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : !enabled ? (
            <WaitlistForm
              description="首批试用名额邀请制开放中。留下手机号，开通专员会联系您开通试用账号。"
              utm={utm}
              onSwitchToLogin={onSwitchToLogin}
            />
          ) : showWaitlist ? (
            <WaitlistForm
              description="收不到验证码？留下手机号，开通专员会联系您人工开通试用账号。"
              utm={utm}
              onSwitchToLogin={onSwitchToLogin}
            />
          ) : (
            <form onSubmit={handleSubmit} className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="signup-phone">手机号</Label>
                <Input
                  id="signup-phone"
                  type="tel"
                  inputMode="numeric"
                  autoComplete="tel"
                  maxLength={11}
                  value={phone}
                  onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
                  required
                  disabled={loading}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="signup-code">验证码</Label>
                <div className="flex gap-2">
                  <Input
                    id="signup-code"
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                    required
                    disabled={loading}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    className="w-32 shrink-0"
                    onClick={handleSendCode}
                    disabled={sending || countdown > 0 || loading}
                  >
                    {sending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : countdown > 0 ? (
                      `${countdown}s 后重发`
                    ) : (
                      "获取验证码"
                    )}
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="signup-password">设置密码</Label>
                <Input
                  id="signup-password"
                  type="password"
                  autoComplete="new-password"
                  placeholder="至少 6 位，后续用手机号+密码登录"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={6}
                  disabled={loading}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="signup-name">怎么称呼您</Label>
                <Input
                  id="signup-name"
                  type="text"
                  maxLength={20}
                  placeholder="如：张总、李经理"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  disabled={loading}
                />
              </div>
              <div className="space-y-2">
                <Label>您的岗位</Label>
                <Select value={position} onValueChange={setPosition} disabled={loading}>
                  <SelectTrigger>
                    <SelectValue placeholder="选择岗位，AI 同事按岗位为您准备场景" />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLE_POSITION_OPTIONS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="signup-company">
                  公司名称
                  <span className="ml-1 text-xs text-muted-foreground">（选填）</span>
                </Label>
                <Input
                  id="signup-company"
                  type="text"
                  maxLength={50}
                  autoComplete="organization"
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  disabled={loading}
                />
              </div>
              {error && (
                <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              )}
              {(sendFailed || (sentOnce && countdown === 0)) && (
                <p className="text-xs text-muted-foreground">
                  收不到验证码？（部分运营商短信通道升级中）
                  <button
                    type="button"
                    className="ml-1 text-brand-600 hover:underline"
                    onClick={() => setShowWaitlist(true)}
                  >
                    留下手机号，由专员人工开通 →
                  </button>
                </p>
              )}
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    开通中...
                  </>
                ) : (
                  "注册并开始试用"
                )}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                已有账号？
                <button
                  type="button"
                  className="ml-1 text-brand-600 hover:underline"
                  onClick={onSwitchToLogin}
                >
                  去登录
                </button>
              </p>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
