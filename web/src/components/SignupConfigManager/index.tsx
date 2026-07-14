import { useCallback, useEffect, useState } from "react";
import {
  CircleAlert,
  TriangleAlert,
  CircleCheck,
  Loader2,
  MessageSquare,
  RefreshCw,
  Save,
  Settings2,
  UserPlus,
} from "lucide-react";
import { EntityIcons } from "@/lib/icons";
import {
  fetchSignupConfig,
  updateSignupConfig,
  type SignupConfig,
  type SignupConfigAdminView,
  type SignupSmsConfig,
  type SignupSmsProvider,
  type UpdateSignupConfigRequest,
} from "@agent/shared";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { SettingsPanelHeader } from "@/components/SettingsCenter/SettingsPanelHeader";

/** GET 回来 config.sms 可能为 undefined，hydrate 时按后端缺省值补齐 */
const DEFAULT_SMS: SignupSmsConfig = {
  provider: "aliyun",
  codeTtlSeconds: 300,
  cooldownSeconds: 60,
  dailyLimitPerPhone: 10,
  maxVerifyAttempts: 5,
  maxSendPerIpPerMinute: 5,
  maxRegisterPerIpPerMinute: 5,
};

type SmsNumericKey =
  | "codeTtlSeconds"
  | "cooldownSeconds"
  | "dailyLimitPerPhone"
  | "maxVerifyAttempts"
  | "maxSendPerIpPerMinute"
  | "maxRegisterPerIpPerMinute";

const RATE_LIMIT_FIELDS: Array<{ key: SmsNumericKey; label: string; min: number; max: number }> = [
  { key: "codeTtlSeconds", label: "验证码有效期（秒，60-1800）", min: 60, max: 1800 },
  { key: "cooldownSeconds", label: "同手机号发送冷却（秒，30-600）", min: 30, max: 600 },
  { key: "dailyLimitPerPhone", label: "同手机号每日发送上限（1-50）", min: 1, max: 50 },
  { key: "maxVerifyAttempts", label: "验证码最大错误尝试（1-10）", min: 1, max: 10 },
  { key: "maxSendPerIpPerMinute", label: "同 IP 每分钟发送上限（1-60）", min: 1, max: 60 },
  { key: "maxRegisterPerIpPerMinute", label: "同 IP 每分钟注册上限（1-60）", min: 1, max: 60 },
];

interface SmsDraft {
  provider: SignupSmsProvider;
  accessKeyId: string;
  signName: string;
  templateCode: string;
  codeTtlSeconds?: number;
  cooldownSeconds?: number;
  dailyLimitPerPhone?: number;
  maxVerifyAttempts?: number;
  maxSendPerIpPerMinute?: number;
  maxRegisterPerIpPerMinute?: number;
}

interface SignupDraft {
  enabled: boolean;
  grantCredits?: number;
  dingtalkLeadWebhook: string;
  sms: SmsDraft;
}

function draftFromConfig(config: SignupConfig | null): SignupDraft {
  const sms = config?.sms;
  return {
    enabled: config?.enabled ?? false,
    grantCredits: config?.grantCredits,
    dingtalkLeadWebhook: config?.dingtalkLeadWebhook ?? "",
    sms: {
      provider: sms?.provider ?? DEFAULT_SMS.provider,
      accessKeyId: sms?.accessKeyId ?? "",
      signName: sms?.signName ?? "",
      templateCode: sms?.templateCode ?? "",
      codeTtlSeconds: sms?.codeTtlSeconds ?? DEFAULT_SMS.codeTtlSeconds,
      cooldownSeconds: sms?.cooldownSeconds ?? DEFAULT_SMS.cooldownSeconds,
      dailyLimitPerPhone: sms?.dailyLimitPerPhone ?? DEFAULT_SMS.dailyLimitPerPhone,
      maxVerifyAttempts: sms?.maxVerifyAttempts ?? DEFAULT_SMS.maxVerifyAttempts,
      maxSendPerIpPerMinute: sms?.maxSendPerIpPerMinute ?? DEFAULT_SMS.maxSendPerIpPerMinute,
      maxRegisterPerIpPerMinute: sms?.maxRegisterPerIpPerMinute ?? DEFAULT_SMS.maxRegisterPerIpPerMinute,
    },
  };
}

function splitLines(value: string): string[] {
  const seen = new Set<string>();
  return value
    .split(/\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

function numberOrUndefined(value: string): number | undefined {
  if (value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 前端简单 clamp：无效值回退 fallback，超范围收敛到边界（后端 zod 仍有兜底校验） */
function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return iso;
  }
}

export function SignupConfigManager() {
  const [view, setView] = useState<SignupConfigAdminView | null>(null);
  const [draft, setDraft] = useState<SignupDraft>(() => draftFromConfig(null));
  const [allowedModelsText, setAllowedModelsText] = useState("");
  const [secretText, setSecretText] = useState("");
  const [clearSecret, setClearSecret] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const markDirty = useCallback(() => {
    setDirty(true);
    setSavedAt(null);
    setError(null);
  }, []);

  const hydrate = useCallback((response: SignupConfigAdminView) => {
    setView(response);
    setDraft(draftFromConfig(response.config));
    setAllowedModelsText((response.config.allowedModels ?? []).join("\n"));
    setSecretText("");
    setClearSecret(false);
    setDirty(false);
    setSavedAt(null);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetchSignupConfig();
      hydrate(response);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [hydrate]);

  useEffect(() => { void refresh(); }, [refresh]);

  const updateDraft = useCallback((updater: (current: SignupDraft) => SignupDraft) => {
    setDraft((current) => updater(current));
    markDirty();
  }, [markDirty]);

  const updateSms = useCallback((patch: Partial<SmsDraft>) => {
    updateDraft((current) => ({ ...current, sms: { ...current.sms, ...patch } }));
  }, [updateDraft]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const grantCredits = Number(draft.grantCredits);
      if (!Number.isFinite(grantCredits) || grantCredits <= 0) {
        throw new Error("注册赠送积分必须是正整数");
      }
      const models = splitLines(allowedModelsText);
      const webhook = draft.dingtalkLeadWebhook.trim();
      const sms: SignupSmsConfig = {
        provider: draft.sms.provider,
        ...(draft.sms.accessKeyId.trim() ? { accessKeyId: draft.sms.accessKeyId.trim() } : {}),
        ...(draft.sms.signName.trim() ? { signName: draft.sms.signName.trim() } : {}),
        ...(draft.sms.templateCode.trim() ? { templateCode: draft.sms.templateCode.trim() } : {}),
        codeTtlSeconds: clampInt(draft.sms.codeTtlSeconds, 60, 1800, DEFAULT_SMS.codeTtlSeconds),
        cooldownSeconds: clampInt(draft.sms.cooldownSeconds, 30, 600, DEFAULT_SMS.cooldownSeconds),
        dailyLimitPerPhone: clampInt(draft.sms.dailyLimitPerPhone, 1, 50, DEFAULT_SMS.dailyLimitPerPhone),
        maxVerifyAttempts: clampInt(draft.sms.maxVerifyAttempts, 1, 10, DEFAULT_SMS.maxVerifyAttempts),
        maxSendPerIpPerMinute: clampInt(draft.sms.maxSendPerIpPerMinute, 1, 60, DEFAULT_SMS.maxSendPerIpPerMinute),
        maxRegisterPerIpPerMinute: clampInt(draft.sms.maxRegisterPerIpPerMinute, 1, 60, DEFAULT_SMS.maxRegisterPerIpPerMinute),
      };
      const config: SignupConfig = {
        enabled: draft.enabled,
        grantCredits: Math.floor(grantCredits),
        // 空数组 → undefined：缺省 = 仅使用全局默认模型
        ...(models.length > 0 ? { allowedModels: models } : {}),
        // 空字符串必须转 undefined：后端 zod .url() 会拒空串
        ...(webhook ? { dingtalkLeadWebhook: webhook } : {}),
        sms,
      };
      const payload: UpdateSignupConfigRequest = { config };
      if (clearSecret) payload.smsAccessKeySecret = null;
      else if (secretText.trim()) payload.smsAccessKeySecret = secretText.trim();
      const response = await updateSignupConfig(payload);
      hydrate(response);
      setSavedAt(Date.now());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [allowedModelsText, clearSecret, draft, hydrate, secretText]);

  const signupUrl = `${window.location.origin}/signup`;
  const secretPlaceholder = view?.smsSecretConfigured
    ? `已配置（来源：${view.smsSecretSource === "vault" ? "配置页" : "环境变量"}），留空则不修改`
    : "未配置，必填（aliyun 模式）";

  if (loading && !view && !dirty) {
    return <div className="flex flex-1 items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col">
      <SettingsPanelHeader
        title="注册管理"
        description="配置自助注册开关、赠送积分、短信通道与风控限流；保存后即时生效，无需重启。"
        actions={(
          <>
            {dirty && <Badge variant="outline">有未保存更改</Badge>}
            {savedAt && !dirty && <Badge variant="secondary" className="gap-1"><CircleCheck className="size-3" />已保存，即时生效（无需重启）</Badge>}
            <Button variant="outline" size="sm" onClick={() => { void refresh(); }} disabled={loading || saving}>
              <RefreshCw className="size-3.5" />
              刷新
            </Button>
            <Button size="sm" onClick={() => { void save(); }} disabled={saving || !dirty}>
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
              保存并生效
            </Button>
          </>
        )}
      />

      <div className="min-h-0 flex-1 space-y-4 overflow-auto">
        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <Card>
          <CardContent className="space-y-3 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <UserPlus className="size-4" />
                <span className="text-sm font-medium">自助注册状态</span>
                {view?.publicEnabled
                  ? <Badge className="border-0 bg-success/15 text-success">注册开放中</Badge>
                  : <Badge className="border-0 bg-muted text-muted-foreground">未开放</Badge>}
              </div>
              <div className="text-xs text-muted-foreground">
                {view?.updatedAt
                  ? `更新于 ${formatTime(view.updatedAt)}${view.updatedBy ? ` · ${view.updatedBy}` : ""}`
                  : "尚未保存过配置"}
              </div>
            </div>
            {view?.smsError && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
                <span>短信通道不可用：{view.smsError}</span>
              </div>
            )}
            <div className="rounded-lg border bg-muted/20 p-3">
              <div className="text-xs font-medium text-muted-foreground">注册页地址</div>
              <div className="mt-1 break-all font-mono text-sm">{signupUrl}</div>
              <p className="mt-1 text-xs text-muted-foreground">官网/销售可直接分发此链接，支持 ?utm_source= 等参数。</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base"><Settings2 className="size-4" />基础设置</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
              <div>
                <Label className="text-sm font-medium">开放自助注册</Label>
                <p className="mt-1 text-xs text-muted-foreground">开启后 /signup 页面对外可用；实际生效还需短信通道配置就绪。</p>
              </div>
              <Switch
                checked={draft.enabled}
                onCheckedChange={(checked) => updateDraft((current) => ({ ...current, enabled: checked }))}
              />
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="signup-grant-credits">注册赠送积分</Label>
                <Input
                  id="signup-grant-credits"
                  type="number"
                  min={1}
                  value={draft.grantCredits ?? ""}
                  onChange={(event) => updateDraft((current) => ({ ...current, grantCredits: numberOrUndefined(event.target.value) }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="signup-dingtalk-webhook">注册线索钉钉群 Webhook</Label>
                <Input
                  id="signup-dingtalk-webhook"
                  value={draft.dingtalkLeadWebhook}
                  onChange={(event) => updateDraft((current) => ({ ...current, dingtalkLeadWebhook: event.target.value }))}
                  placeholder="https://oapi.dingtalk.com/robot/send?access_token=...（留空不推送）"
                />
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="signup-allowed-models">试用租户模型白名单</Label>
                <Textarea
                  id="signup-allowed-models"
                  className="min-h-20 font-mono text-xs"
                  value={allowedModelsText}
                  onChange={(event) => { setAllowedModelsText(event.target.value); markDirty(); }}
                  placeholder="留空 = 仅使用全局默认模型"
                />
                <p className="text-xs text-muted-foreground">
                  每行一个 "group/model" ref。当前实际生效：{view && view.effectiveAllowedModels.length > 0 ? view.effectiveAllowedModels.join(", ") : "-"}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base"><MessageSquare className="size-4" />短信通道</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="signup-sms-provider">短信服务商</Label>
                <Select
                  value={draft.sms.provider}
                  onValueChange={(value) => updateSms({ provider: value as SignupSmsProvider })}
                >
                  <SelectTrigger id="signup-sms-provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="aliyun">阿里云短信</SelectItem>
                    <SelectItem value="dev">开发模式</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="signup-sms-access-key-id">AccessKey ID</Label>
                <Input
                  id="signup-sms-access-key-id"
                  value={draft.sms.accessKeyId}
                  onChange={(event) => updateSms({ accessKeyId: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="signup-sms-sign-name">短信签名</Label>
                <Input
                  id="signup-sms-sign-name"
                  value={draft.sms.signName}
                  onChange={(event) => updateSms({ signName: event.target.value })}
                  placeholder="福建开沿科技"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="signup-sms-template-code">模板 Code</Label>
                <Input
                  id="signup-sms-template-code"
                  value={draft.sms.templateCode}
                  onChange={(event) => updateSms({ templateCode: event.target.value })}
                  placeholder="SMS_335950263"
                />
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="signup-sms-secret">AccessKey Secret</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="signup-sms-secret"
                    type="password"
                    autoComplete="new-password"
                    passwordManager="ignore"
                    value={secretText}
                    disabled={clearSecret}
                    onChange={(event) => { setSecretText(event.target.value); markDirty(); }}
                    placeholder={secretPlaceholder}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={clearSecret || !view?.smsSecretConfigured}
                    onClick={() => { setClearSecret(true); setSecretText(""); markDirty(); }}
                  >
                    清除
                  </Button>
                </div>
                {clearSecret && (
                  <p className="text-xs text-warning">
                    已标记清除：保存后将删除配置页保存的 Secret（回退环境变量）。
                    <button type="button" className="ml-1 underline" onClick={() => { setClearSecret(false); markDirty(); }}>撤销</button>
                  </p>
                )}
              </div>
            </div>
            {draft.sms.provider === "dev" && (
              <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <span>开发模式：验证码只打印到服务端日志，仅用于内测，请勿对外开放。</span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base"><EntityIcons.admin className="size-4" />风控限流</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 md:grid-cols-2">
              {RATE_LIMIT_FIELDS.map((field) => (
                <div key={field.key} className="space-y-1.5">
                  <Label htmlFor={`signup-sms-${field.key}`}>{field.label}</Label>
                  <Input
                    id={`signup-sms-${field.key}`}
                    type="number"
                    min={field.min}
                    max={field.max}
                    value={draft.sms[field.key] ?? ""}
                    onChange={(event) => updateSms({ [field.key]: numberOrUndefined(event.target.value) })}
                  />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
