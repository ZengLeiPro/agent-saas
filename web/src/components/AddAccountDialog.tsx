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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const PHONE_PATTERN = /^1[3-9]\d{9}$/;

interface AddAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddAccountDialog({ open, onOpenChange }: AddAccountDialogProps) {
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
  const timerRef = useRef<ReturnType<typeof setInterval>>();

  useEffect(() => {
    if (!open) return;
    setLoginMode("password");
    setUsername("");
    setPassword("");
    setPhone("");
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader className="text-center sm:text-center">
          <DialogTitle className="text-2xl">登录</DialogTitle>
          <DialogDescription>登录后会把账号添加到此设备，可随时快速切换。</DialogDescription>
        </DialogHeader>

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
            {loading ? <><Loader2 className="size-4 animate-spin" />登录中...</> : "继续"}
          </Button>
        </form>
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
          <Input id={`${prefix}-code`} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => onCodeChange(event.target.value.replace(/\D/g, ""))} required disabled={disabled} />
          <Button type="button" variant="outline" className="w-32 shrink-0" onClick={onSendCode} disabled={sendingCode || countdown > 0 || disabled}>
            {sendingCode ? <Loader2 className="size-4 animate-spin" /> : countdown > 0 ? `${countdown}s 后重发` : "获取验证码"}
          </Button>
        </div>
      </div>
    </>
  );
}
