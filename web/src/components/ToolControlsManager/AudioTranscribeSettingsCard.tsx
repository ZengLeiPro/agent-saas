import { useCallback, useEffect, useState } from "react";
import {
  AudioLines,
  CircleAlert,
  CircleCheck,
  KeyRound,
  Loader2,
  RefreshCw,
  Save,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/contexts/AuthContext";
import { authFetch } from "@/lib/authFetch";

export interface AudioTranscribeAdminResponse {
  config: {
    enabled: boolean;
    model?: string;
    ossBucket?: string;
    ossEndpoint?: string;
    apiKeyConfigured: boolean;
    ossAccessKeyIdConfigured: boolean;
    ossAccessKeySecretConfigured: boolean;
  };
  pricing: {
    creditsPerCall: number;
    costYuanPerCall: number;
  } | null;
  status: {
    available: boolean;
    platformEnabled: boolean;
    toolEnabled: boolean;
    credentialsConfigured: boolean;
  };
  error?: string;
}

interface AudioTranscribeDraft {
  enabled: boolean;
  model: string;
  ossBucket: string;
  ossEndpoint: string;
  apiKey: string;
  ossAccessKeyId: string;
  ossAccessKeySecret: string;
  apiKeyConfigured: boolean;
  ossAccessKeyIdConfigured: boolean;
  ossAccessKeySecretConfigured: boolean;
  creditsPerCall: string;
  costYuanPerCall: string;
}

function hydrateDraft(data: AudioTranscribeAdminResponse): AudioTranscribeDraft {
  return {
    enabled: data.config.enabled,
    model: data.config.model ?? "",
    ossBucket: data.config.ossBucket ?? "",
    ossEndpoint: data.config.ossEndpoint ?? "",
    apiKey: "",
    ossAccessKeyId: "",
    ossAccessKeySecret: "",
    apiKeyConfigured: data.config.apiKeyConfigured,
    ossAccessKeyIdConfigured: data.config.ossAccessKeyIdConfigured,
    ossAccessKeySecretConfigured: data.config.ossAccessKeySecretConfigured,
    creditsPerCall: data.pricing ? String(data.pricing.creditsPerCall) : "",
    costYuanPerCall: data.pricing ? String(data.pricing.costYuanPerCall) : "",
  };
}

function parsePricing(draft: AudioTranscribeDraft) {
  const creditsPerCall = Number(draft.creditsPerCall);
  const costYuanPerCall = Number(draft.costYuanPerCall);
  if (!Number.isInteger(creditsPerCall) || creditsPerCall < 0) {
    throw new Error("积分/次必须是大于或等于 0 的整数");
  }
  if (!Number.isFinite(costYuanPerCall) || costYuanPerCall < 0) {
    throw new Error("成本元/次必须是大于或等于 0 的数字");
  }
  return { creditsPerCall, costYuanPerCall };
}

export function AudioTranscribeSettingsCard(): JSX.Element {
  const { platformReadOnly } = useAuth();
  const [data, setData] = useState<AudioTranscribeAdminResponse | null>(null);
  const [draft, setDraft] = useState<AudioTranscribeDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hydrate = useCallback((next: AudioTranscribeAdminResponse) => {
    setData(next);
    setDraft(hydrateDraft(next));
    setDirty(false);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await authFetch("/api/admin/audio-transcribe");
      const body = await response.json().catch(() => ({})) as Partial<AudioTranscribeAdminResponse>;
      if (!response.ok || !body.config || !body.status) {
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      hydrate(body as AudioTranscribeAdminResponse);
      setSaved(false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [hydrate]);

  useEffect(() => { void refresh(); }, [refresh]);

  const updateDraft = useCallback((patch: Partial<AudioTranscribeDraft>) => {
    setDraft((current) => current ? { ...current, ...patch } : current);
    setDirty(true);
    setSaved(false);
    setError(null);
  }, []);

  const save = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    try {
      if (!draft.model.trim()) throw new Error("model 不能为空");
      if (!draft.ossBucket.trim()) throw new Error("OSS_BUCKET 不能为空");
      if (!draft.ossEndpoint.trim()) throw new Error("OSS_ENDPOINT 不能为空");
      const pricing = parsePricing(draft);
      const response = await authFetch("/api/admin/audio-transcribe", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          config: {
            enabled: draft.enabled,
            model: draft.model.trim(),
            ossBucket: draft.ossBucket.trim(),
            ossEndpoint: draft.ossEndpoint.trim(),
            apiKey: draft.apiKey.trim(),
            ossAccessKeyId: draft.ossAccessKeyId.trim(),
            ossAccessKeySecret: draft.ossAccessKeySecret.trim(),
          },
          pricing,
        }),
      });
      const body = await response.json().catch(() => ({})) as Partial<AudioTranscribeAdminResponse>;
      if (!response.ok || !body.config || !body.status) {
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      hydrate(body as AudioTranscribeAdminResponse);
      setSaved(true);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [draft, hydrate]);

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <AudioLines className="size-4" />运行时参数（AudioTranscribe）
        </CardTitle>
        <div className="flex items-center gap-2">
          {dirty && <Badge variant="outline">有未保存更改</Badge>}
          {saved && !dirty && (
            <Badge variant="secondary" className="gap-1">
              <CircleCheck className="size-3" />已保存并热生效
            </Badge>
          )}
          <Button variant="outline" size="sm" onClick={() => { void refresh(); }} disabled={loading || saving}>
            <RefreshCw className="size-3.5" />刷新
          </Button>
          <Button size="sm" onClick={() => { void save(); }} disabled={platformReadOnly || saving || !dirty || !draft}>
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
            保存语音转写配置
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          三项凭据不会回显；留空保存表示保留已配置值，填写新值表示替换。保存后只影响后续语音转写调用。
        </p>

        {data?.status && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-xs text-muted-foreground">
            <Badge variant={data.status.available ? "secondary" : "outline"}>
              {data.status.available ? "平台语音转写可用" : "平台语音转写未就绪"}
            </Badge>
            {!data.status.platformEnabled && <Badge variant="outline">平台能力未启用</Badge>}
            {!data.status.toolEnabled && <Badge variant="outline">全局工具已关闭</Badge>}
            <span>{data.status.credentialsConfigured ? "所需凭据已配置" : "所需凭据未完整配置"}</span>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            <span className="break-all">{error}</span>
          </div>
        )}

        {loading && !draft ? (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />加载语音转写配置…
          </div>
        ) : draft ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
              <div>
                <Label className="text-sm font-medium">启用平台语音转写能力</Label>
                <p className="mt-1 text-xs text-muted-foreground">与全局工具开关共同决定 AudioTranscribe 是否可用。</p>
              </div>
              <Switch
                checked={draft.enabled}
                disabled={platformReadOnly}
                onCheckedChange={(checked) => updateDraft({ enabled: checked })}
                aria-label="启用平台语音转写能力"
              />
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="audio-transcribe-model">模型（model）</Label>
                <Input id="audio-transcribe-model" value={draft.model} onChange={(event) => updateDraft({ model: event.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="audio-transcribe-oss-bucket">OSS_BUCKET</Label>
                <Input id="audio-transcribe-oss-bucket" value={draft.ossBucket} onChange={(event) => updateDraft({ ossBucket: event.target.value })} />
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="audio-transcribe-oss-endpoint">OSS_ENDPOINT</Label>
                <Input id="audio-transcribe-oss-endpoint" value={draft.ossEndpoint} onChange={(event) => updateDraft({ ossEndpoint: event.target.value })} placeholder="https://oss-cn-hangzhou.aliyuncs.com" />
              </div>
              <SecretField
                id="audio-transcribe-api-key"
                label="DASHSCOPE_API_KEY"
                value={draft.apiKey}
                configured={draft.apiKeyConfigured}
                onChange={(value) => updateDraft({ apiKey: value })}
              />
              <SecretField
                id="audio-transcribe-access-key-id"
                label="OSS_ACCESS_KEY_ID"
                value={draft.ossAccessKeyId}
                configured={draft.ossAccessKeyIdConfigured}
                onChange={(value) => updateDraft({ ossAccessKeyId: value })}
              />
              <SecretField
                id="audio-transcribe-access-key-secret"
                label="OSS_ACCESS_KEY_SECRET"
                value={draft.ossAccessKeySecret}
                configured={draft.ossAccessKeySecretConfigured}
                onChange={(value) => updateDraft({ ossAccessKeySecret: value })}
              />
              <div className="space-y-1.5">
                <Label htmlFor="audio-transcribe-credits">积分/次</Label>
                <Input id="audio-transcribe-credits" type="number" min={0} step={1} value={draft.creditsPerCall} onChange={(event) => updateDraft({ creditsPerCall: event.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="audio-transcribe-cost">成本元/次</Label>
                <Input id="audio-transcribe-cost" type="number" min={0} step={0.01} value={draft.costYuanPerCall} onChange={(event) => updateDraft({ costYuanPerCall: event.target.value })} />
              </div>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SecretField(props: {
  id: string;
  label: string;
  value: string;
  configured: boolean;
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={props.id}>{props.label}</Label>
        <Badge variant={props.configured ? "secondary" : "outline"} className="gap-1">
          <KeyRound className="size-3" />{props.configured ? "已配置" : "未配置"}
        </Badge>
      </div>
      <Input
        id={props.id}
        type="password"
        autoComplete="new-password"
        passwordManager="ignore"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        placeholder={props.configured ? "留空保留现有值；填写则替换" : "请输入新值"}
      />
    </div>
  );
}
