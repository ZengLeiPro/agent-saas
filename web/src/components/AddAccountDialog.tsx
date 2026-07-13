import { useEffect, useRef, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import type { AuthUser } from "@/types/auth";
import { ROLE_POSITION_OPTIONS } from "@/lib/roleOptions";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const PHONE_PATTERN = /^1[3-9]\d{9}$/;

interface AddAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface AuthResponse {
  token: string;
  user: AuthUser;
  error?: string;
}

export function AddAccountDialog({ open, onOpenChange }: AddAccountDialogProps) {
  const { login, loginWithSms, activateAccount } = useAuth();
  const [authMode, setAuthMode] = useState<"login" | "signup">("login");
  const [loginMode, setLoginMode] = useState<"password" | "sms">("password");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [position, setPosition] = useState("");
  const [company, setCompany] = useState("");
  const [signupEnabled, setSignupEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    if (!open) return;
    setAuthMode("login");
    setLoginMode("password");
    setUsername("");
    setPassword("");
    setPhone("");
    setCode("");
    setName("");
    setPosition("");
    setCompany("");
    setError("");
    setLoading(false);
    setCountdown(0);
    fetch("/api/signup/status")
      .then((res) => res.json())
      .then((data: { enabled?: boolean }) => setSignupEnabled(data.enabled === true))
      .catch(() => setSignupEnabled(false));
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
    if (!PHONE_PATTERN.test(phone)) {
      setError("请输入有效的 11 位手机号");
      return;
    }
    setError("");
    setSendingCode(true);
    try {
      const endpoint = authMode === "signup" ? "/api/signup/send-code" : "/api/auth/sms/send-code";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone }),
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
    if (loginMode === "sms" && !PHONE_PATTERN.test(phone)) {
      setError("请输入有效的 11 位手机号");
      return;
    }
    setLoading(true);
    try {
      if (loginMode === "password") await login({ username, password });
      else await loginWithSms({ phone, code });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
      setLoading(false);
    }
  };

  const handleSignup = async (event: FormEvent) => {
    event.preventDefault();
    if (!PHONE_PATTERN.test(phone)) {
      setError("请输入有效的 11 位手机号");
      return;
    }
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
        body: JSON.stringify({ phone, code, password, name, position, company: company || undefined }),
      });
      const data = await res.json().catch(() => ({})) as Partial<AuthResponse>;
      if (!res.ok || !data.token || !data.user) throw new Error(data.error || "注册失败");
      activateAccount({ token: data.token, user: data.user });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "注册失败");
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader className="text-center sm:text-center">
          <DialogTitle className="text-2xl">登录或注册</DialogTitle>
          <DialogDescription>登录后会把账号添加到此设备，可随时快速切换。</DialogDescription>
        </DialogHeader>

        <Tabs
          value={authMode}
          onValueChange={(value) => {
            setAuthMode(value as "login" | "signup");
            setError("");
            setCountdown(0);
            clearInterval(timerRef.current);
          }}
        >
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="login">登录</TabsTrigger>
            <TabsTrigger value="signup">注册</TabsTrigger>
          </TabsList>

          <TabsContent value="login" className="mt-5">
            <form onSubmit={handleLogin} className="space-y-4">
              <Tabs value={loginMode} onValueChange={(value) => { setLoginMode(value as "password" | "sms"); setError(""); }}>
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="password">密码登录</TabsTrigger>
                  <TabsTrigger value="sms">验证码登录</TabsTrigger>
                </TabsList>
                <TabsContent value="password" className="mt-4 space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="add-account-username">用户名</Label>
                    <Input id="add-account-username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required disabled={loading} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="add-account-password">密码</Label>
                    <Input id="add-account-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required disabled={loading} />
                  </div>
                </TabsContent>
                <TabsContent value="sms" className="mt-4 space-y-4">
                  <PhoneCodeFields phone={phone} code={code} onPhoneChange={setPhone} onCodeChange={setCode} onSendCode={handleSendCode} sendingCode={sendingCode} countdown={countdown} disabled={loading} prefix="add-account-login" />
                </TabsContent>
              </Tabs>
              {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />登录中...</> : "继续"}
              </Button>
            </form>
          </TabsContent>

          <TabsContent value="signup" className="mt-5">
            {signupEnabled === null ? (
              <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
            ) : !signupEnabled ? (
              <div className="rounded-lg border bg-muted/40 px-4 py-5 text-center text-sm text-muted-foreground">
                当前为邀请制注册。请联系管理员开通账号后，再从这里登录添加。
              </div>
            ) : (
              <form onSubmit={handleSignup} className="space-y-3">
                <PhoneCodeFields phone={phone} code={code} onPhoneChange={setPhone} onCodeChange={setCode} onSendCode={handleSendCode} sendingCode={sendingCode} countdown={countdown} disabled={loading} prefix="add-account-signup" />
                <div className="space-y-2">
                  <Label htmlFor="add-account-signup-password">设置密码</Label>
                  <Input id="add-account-signup-password" type="password" autoComplete="new-password" minLength={6} value={password} onChange={(event) => setPassword(event.target.value)} required disabled={loading} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="add-account-name">怎么称呼您</Label>
                  <Input id="add-account-name" maxLength={20} value={name} onChange={(event) => setName(event.target.value)} required disabled={loading} />
                </div>
                <div className="space-y-2">
                  <Label>您的岗位</Label>
                  <Select value={position} onValueChange={setPosition} disabled={loading}>
                    <SelectTrigger><SelectValue placeholder="选择岗位" /></SelectTrigger>
                    <SelectContent>{ROLE_POSITION_OPTIONS.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="add-account-company">公司名称 <span className="text-xs text-muted-foreground">（选填）</span></Label>
                  <Input id="add-account-company" autoComplete="organization" maxLength={50} value={company} onChange={(event) => setCompany(event.target.value)} disabled={loading} />
                </div>
                {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />开通中...</> : "注册并添加账号"}
                </Button>
              </form>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function PhoneCodeFields({
  phone,
  code,
  onPhoneChange,
  onCodeChange,
  onSendCode,
  sendingCode,
  countdown,
  disabled,
  prefix,
}: {
  phone: string;
  code: string;
  onPhoneChange: (value: string) => void;
  onCodeChange: (value: string) => void;
  onSendCode: () => void;
  sendingCode: boolean;
  countdown: number;
  disabled: boolean;
  prefix: string;
}) {
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-phone`}>手机号</Label>
        <Input id={`${prefix}-phone`} type="tel" inputMode="numeric" autoComplete="tel" maxLength={11} value={phone} onChange={(event) => onPhoneChange(event.target.value.replace(/\D/g, ""))} required disabled={disabled} />
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${prefix}-code`}>验证码</Label>
        <div className="flex gap-2">
          <Input id={`${prefix}-code`} inputMode="numeric" maxLength={6} value={code} onChange={(event) => onCodeChange(event.target.value.replace(/\D/g, ""))} required disabled={disabled} />
          <Button type="button" variant="outline" className="w-32 shrink-0" onClick={onSendCode} disabled={sendingCode || countdown > 0 || disabled}>
            {sendingCode ? <Loader2 className="h-4 w-4 animate-spin" /> : countdown > 0 ? `${countdown}s 后重发` : "获取验证码"}
          </Button>
        </div>
      </div>
    </>
  );
}
