import { useCallback, useEffect, useState } from "react";
import { Check, Cloud, ExternalLink, Loader2, Plus, TriangleAlert } from "lucide-react";
import {
  connectAliyun,
  disconnectAliyun,
  fetchAliyunConnection,
  type AliyunConnectInput,
  type AliyunConnection,
} from "@agent/shared";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  CAPABILITY_SUBTLE_SURFACE,
  CAPABILITY_SURFACE,
  CAPABILITY_SURFACE_HOVER,
  CapabilityDetailDrawer,
  CapabilitySourceBadge,
} from "./CatalogUi";

const DISCONNECTED: AliyunConnection = { connectorId: "aliyun", status: "disconnected" };
const DEFAULT_REGION_ID = "cn-shenzhen";
const DESCRIPTION = "使用官方 aliyun CLI 管理 ECS、VPC、OSS、ACR、NAS、DNS 与监控等阿里云资源。";

export interface AliyunConnectorState {
  connection: AliyunConnection;
  loading: boolean;
  saving: boolean;
  error?: string;
  connect: (input: AliyunConnectInput) => Promise<boolean>;
  disconnect: () => Promise<void>;
}

export function useAliyunConnector(enabled = true): AliyunConnectorState {
  const [connection, setConnection] = useState<AliyunConnection>(DISCONNECTED);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    const result = await fetchAliyunConnection();
    setConnection(result.connection);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    setLoading(true);
    setError(undefined);
    void load()
      .catch((err) => setError(err instanceof Error ? err.message : "读取阿里云连接失败"))
      .finally(() => setLoading(false));
  }, [enabled, load]);

  const connect = useCallback(async (input: AliyunConnectInput) => {
    setSaving(true);
    setError(undefined);
    try {
      const result = await connectAliyun(input);
      setConnection(result.connection);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "连接阿里云失败");
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    if (!window.confirm("确定断开阿里云？后续运行将不再注入阿里云 STS 凭据。")) return;
    setSaving(true);
    setError(undefined);
    try {
      const result = await disconnectAliyun();
      setConnection(result.connection);
    } catch (err) {
      setError(err instanceof Error ? err.message : "断开阿里云失败");
    } finally {
      setSaving(false);
    }
  }, []);

  return { connection, loading, saving, error, connect, disconnect };
}

function AliyunLogo() {
  return (
    <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-orange-50 text-orange-600 ring-1 ring-inset ring-orange-100 dark:bg-orange-950/40 dark:text-orange-300 dark:ring-orange-900">
      <Cloud className="size-6" />
    </span>
  );
}

export function AliyunConnectorCard({
  state,
  onOpenDetail,
}: {
  state: AliyunConnectorState;
  onOpenDetail: () => void;
}) {
  const connected = state.connection.status === "connected";
  const busy = state.loading || state.saving;
  return (
    <Card
      className={cn("group cursor-pointer border-0 shadow-none", CAPABILITY_SURFACE, CAPABILITY_SURFACE_HOVER)}
      onClick={onOpenDetail}
    >
      <CardContent className="flex min-h-36 items-start gap-4 p-5">
        <AliyunLogo />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-semibold">阿里云</div>
              <div className="mt-1 flex items-center gap-2">
                <CapabilitySourceBadge source="platform" />
                <span className={cn("text-xs font-medium", connected ? "text-success" : "text-muted-foreground")}>
                  {busy ? "检测中" : connected ? "已连接" : "未连接"}
                </span>
              </div>
            </div>
            <button
              type="button"
              aria-label={connected ? "查看阿里云连接" : "连接阿里云"}
              className={cn(
                "flex size-8 items-center justify-center rounded-lg border",
                connected ? "border-transparent bg-success text-success-foreground" : "bg-muted/40 text-muted-foreground",
              )}
              onClick={(event) => { event.stopPropagation(); onOpenDetail(); }}
              disabled={busy}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : connected ? <Check className="size-4" /> : <Plus className="size-4" />}
            </button>
          </div>
          <p className="mt-3 line-clamp-2 text-sm leading-5 text-muted-foreground">{DESCRIPTION}</p>
          <div className="mt-3 text-xs text-muted-foreground">官方 CLI：aliyun</div>
        </div>
      </CardContent>
    </Card>
  );
}

export function AliyunConnectorDrawer({
  open,
  onOpenChange,
  state,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: AliyunConnectorState;
}) {
  const connected = state.connection.status === "connected";
  const [editing, setEditing] = useState(false);
  const [accessKeyId, setAccessKeyId] = useState("");
  const [accessKeySecret, setAccessKeySecret] = useState("");
  const [roleArn, setRoleArn] = useState("");
  const [regionId, setRegionId] = useState(DEFAULT_REGION_ID);
  const [externalId, setExternalId] = useState("");

  useEffect(() => {
    if (!open) {
      setAccessKeyId("");
      setAccessKeySecret("");
      setExternalId("");
      setEditing(false);
      return;
    }
    setRoleArn(state.connection.roleArn ?? "");
    setRegionId(state.connection.regionId ?? DEFAULT_REGION_ID);
    if (!connected) setEditing(true);
  }, [connected, open, state.connection.regionId, state.connection.roleArn]);

  const resetSecrets = () => {
    setAccessKeyId("");
    setAccessKeySecret("");
    setExternalId("");
  };

  const submit = async () => {
    const ok = await state.connect({
      accessKeyId,
      accessKeySecret,
      roleArn,
      regionId,
      ...(externalId.trim() ? { externalId } : {}),
    });
    if (ok) {
      resetSecrets();
      setEditing(false);
    }
  };

  const canSubmit = Boolean(accessKeyId.trim() && accessKeySecret.trim() && roleArn.trim() && regionId.trim());

  return (
    <CapabilityDetailDrawer open={open} onOpenChange={onOpenChange} title="阿里云" description={DESCRIPTION}>
      <div className="flex items-center gap-3">
        <AliyunLogo />
        <div>
          <CapabilitySourceBadge source="platform" />
          <div className={cn("mt-1 text-xs font-medium", connected ? "text-success" : "text-muted-foreground")}>
            {connected ? "已连接，运行环境将使用短期 STS" : "未连接"}
          </div>
        </div>
      </div>

      {connected && !editing ? (
        <div className="space-y-3 rounded-xl p-4 ring-1 ring-border/60">
          <div><div className="text-xs text-muted-foreground">云账号</div><div className="mt-1 font-medium">{state.connection.accountId}</div></div>
          <div><div className="text-xs text-muted-foreground">RAM Role</div><div className="mt-1 break-all text-sm">{state.connection.roleArn}</div></div>
          <div><div className="text-xs text-muted-foreground">默认地域</div><div className="mt-1 text-sm">{state.connection.regionId}</div></div>
        </div>
      ) : null}

      {(!connected || editing) ? (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="aliyun-access-key-id">AccessKey ID</Label>
            <Input id="aliyun-access-key-id" name="aliyun-access-key-id" autoComplete="off" value={accessKeyId} onChange={(event) => setAccessKeyId(event.target.value)} placeholder="LTAI…" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="aliyun-access-key-secret">AccessKey Secret</Label>
            <Input id="aliyun-access-key-secret" name="aliyun-access-key-secret" type="password" autoComplete="new-password" passwordManager="ignore" value={accessKeySecret} onChange={(event) => setAccessKeySecret(event.target.value)} placeholder="仅用于换取短期 STS" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="aliyun-role-arn">RAM Role ARN</Label>
            <Input id="aliyun-role-arn" name="aliyun-role-arn" autoComplete="off" value={roleArn} onChange={(event) => setRoleArn(event.target.value)} placeholder="acs:ram::1234567890123456:role/agent-saas" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="aliyun-region-id">默认地域</Label>
            <Input id="aliyun-region-id" name="aliyun-region-id" autoComplete="off" value={regionId} onChange={(event) => setRegionId(event.target.value)} placeholder={DEFAULT_REGION_ID} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="aliyun-external-id">External ID（可选）</Label>
            <Input id="aliyun-external-id" name="aliyun-external-id" type="password" autoComplete="new-password" passwordManager="ignore" value={externalId} onChange={(event) => setExternalId(event.target.value)} />
          </div>
          <a href="https://help.aliyun.com/zh/ram/user-guide/assume-a-ram-role" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
            配置 RAM Role 与 AssumeRole 权限 <ExternalLink className="size-3.5" />
          </a>
        </div>
      ) : null}

      <div className={cn("p-3 text-sm text-muted-foreground", CAPABILITY_SUBTLE_SURFACE)}>
        请使用仅具备 <code>sts:AssumeRole</code> 的专用 RAM 用户，不要填写主账号 AccessKey。源凭据只保存到个人 SecretVault；运行环境仅获得短期 STS，不会创建共享 <code>~/.aliyun/config.json</code>。
      </div>

      {state.error ? (
        <div className="flex gap-2 rounded-xl bg-destructive/10 p-3 text-sm text-destructive"><TriangleAlert className="mt-0.5 size-4 shrink-0" />{state.error}</div>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        {connected && !editing ? (
          <>
            <Button variant="outline" onClick={() => setEditing(true)} disabled={state.saving}>更新授权</Button>
            <Button variant="destructive" onClick={() => void state.disconnect()} disabled={state.saving}>断开连接</Button>
          </>
        ) : (
          <>
            {connected ? <Button variant="ghost" onClick={() => { resetSecrets(); setEditing(false); }} disabled={state.saving}>取消</Button> : null}
            <Button onClick={() => void submit()} disabled={state.saving || !canSubmit}>
              {state.saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              {connected ? "保存新授权" : "连接阿里云"}
            </Button>
          </>
        )}
      </div>
    </CapabilityDetailDrawer>
  );
}
