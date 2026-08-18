import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";

import { GovernanceUnavailable } from "@/components/Governance/GovernanceUnavailable";
import { Switch } from "@/components/ui/switch";
import { authFetch } from "@/lib/authFetch";
import { useGovernanceRequest } from "@/hooks/useGovernanceRequest";
import { governanceAccessApi } from "@agent/shared/lib/governanceApi";
import type { TenantSettings } from "@/components/TenantManager/types";

interface GovernedTenantSettingsResponse {
  tenantId: string;
  settings: TenantSettings;
  updatedAt: string;
}

export function TenantDebugModeSetting({
  tenantId,
  level,
}: {
  tenantId: string;
  level: "platform" | "organization";
}) {
  const { user, updateTenantFeatures } = useAuth();
  const request = useMemo(
    () => () => governanceAccessApi.getTenantSettings<GovernedTenantSettingsResponse>(tenantId),
    [tenantId],
  );
  const { data, loading, error, retry } = useGovernanceRequest(
    request,
    `debug-mode-settings:${level}:${tenantId}`,
  );
  const [current, setCurrent] = useState<GovernedTenantSettingsResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => setCurrent(data), [data]);
  useEffect(() => {
    setMutationError(null);
    setSaved(false);
  }, [level, tenantId]);

  if (loading) {
    return <div className="flex min-h-32 items-center justify-center text-sm text-muted-foreground">正在读取调试模式策略…</div>;
  }
  if (error || !current) {
    return <GovernanceUnavailable error={error ?? new Error("调试模式策略不可用")} onRetry={retry} />;
  }

  const features = current.settings.features;
  const platformAllowed = features.debugModeAllowed === true;
  const checked = level === "platform"
    ? platformAllowed
    : platformAllowed && features.debugModeEnabled === true;
  const disabled = saving || (level === "organization" && !platformAllowed);
  const label = level === "platform" ? "调试模式授权" : "成员调试模式";
  const description = level === "platform"
    ? "允许该组织向成员开放个人调试模式。关闭授权会同步关闭组织开关，并清理该组织成员已开启状态。"
    : platformAllowed
      ? "开启后，成员可在个人权限中选择是否显示思考、工具调用和技能执行细节；关闭会清理成员已开启状态。"
      : "平台尚未授予调试模式，组织与成员均不能开启。";

  const update = async (next: boolean) => {
    setSaving(true);
    setMutationError(null);
    setSaved(false);
    try {
      const nextFeatures = {
        ...features,
        ...(level === "platform"
          ? { debugModeAllowed: next, ...(!next ? { debugModeEnabled: false } : {}) }
          : { debugModeEnabled: next }),
      };
      const result = await governanceAccessApi.updateTenantSettings<GovernedTenantSettingsResponse>(tenantId, {
        settings: { ...current.settings, features: nextFeatures },
        expectedUpdatedAt: current.updatedAt,
      });
      setCurrent(result);
      if (user?.tenantId === tenantId) updateTenantFeatures(result.settings.features);
      setSaved(true);
    } catch (cause) {
      setMutationError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return <div className="rounded-xl border bg-card p-4">
    <div className="flex items-start justify-between gap-4">
      <div>
        <div className="font-medium">{label}</div>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={next => void update(next)}
        aria-label={label}
      />
    </div>
    {saved ? <div className="mt-2 text-xs text-success">策略已保存</div> : null}
    {mutationError ? <div role="alert" className="mt-2 text-sm text-destructive">{mutationError}</div> : null}
  </div>;
}

export function MemberDebugModeSetting({
  userId,
  enabled,
  available,
  onSaved,
}: {
  userId: string;
  enabled: boolean;
  available: boolean;
  onSaved: () => void;
}) {
  const [checked, setChecked] = useState(enabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setChecked(enabled), [enabled, userId]);
  if (!available) return null;

  const update = async (next: boolean) => {
    setSaving(true);
    setError(null);
    try {
      const response = await authFetch(`/api/auth/users/${encodeURIComponent(userId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ debugMode: next }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error((payload as { error?: string }).error || `更新成员失败（HTTP ${response.status}）`);
      }
      setChecked(next);
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return <div className="rounded-xl border bg-card p-4">
    <div className="flex items-start justify-between gap-4">
      <div>
        <div className="font-medium">调试模式</div>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          平台与组织均已开放。开启后，该成员可查看思考、工具调用和技能执行细节。
        </p>
      </div>
      <Switch
        checked={checked}
        disabled={saving}
        onCheckedChange={next => void update(next)}
        aria-label="成员个人调试模式"
      />
    </div>
    {error ? <div role="alert" className="mt-2 text-sm text-destructive">{error}</div> : null}
  </div>;
}
