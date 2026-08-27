import { useCallback, useEffect, useRef, useState } from "react";
import { CircleCheck, Loader2, RefreshCw, Save } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSettingsDirtyEntry } from "@/components/PersonalSettings/dirtyRegistry";
import { EntityIcons } from "@/lib/icons";

import { useAcsRuntimeConfig } from "./hooks";
import type { AcsRuntimeConfig } from "./types";

type AcsRuntimeDraft = {
  maxRunningText: string;
  warnRunningText: string;
  drainDeadlineText: string;
};

function draftMatchesConfig(draft: AcsRuntimeDraft, config: AcsRuntimeConfig): boolean {
  return draft.maxRunningText === String(config.maxRunningSandboxes)
    && draft.warnRunningText === String(config.warnRunningSandboxes)
    && draft.drainDeadlineText === String(config.drainDeadlineMs);
}

function parseLimit(label: string, value: string): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) throw new Error(`${label}必须是 0-1000 的整数`);
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1_000) {
    throw new Error(`${label}必须是 0-1000 的整数`);
  }
  return parsed;
}

function parseDuration(value: string): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) throw new Error("排空超时必须是毫秒整数");
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 24 * 60 * 60_000) {
    throw new Error("排空超时必须在 1000-86400000 毫秒之间");
  }
  return parsed;
}

export function AcsRuntimeSettingsCard({ readOnly }: { readOnly: boolean }) {
  const { config, loading, saving, error, savedAt, refresh, save } = useAcsRuntimeConfig();
  const [maxRunningText, setMaxRunningText] = useState("");
  const [warnRunningText, setWarnRunningText] = useState("");
  const [drainDeadlineText, setDrainDeadlineText] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<AcsRuntimeConfig | null>(null);
  const baselineRef = useRef<AcsRuntimeConfig | null>(null);
  const draftRef = useRef<AcsRuntimeDraft>({ maxRunningText, warnRunningText, drainDeadlineText });
  draftRef.current = { maxRunningText, warnRunningText, drainDeadlineText };

  const dirty = baseline !== null && !draftMatchesConfig(draftRef.current, baseline);
  useEffect(() => {
    if (!config) return;
    const previous = baselineRef.current;
    const hadLocalDraft = previous !== null && !draftMatchesConfig(draftRef.current, previous);
    baselineRef.current = config;
    setBaseline(config);
    if (hadLocalDraft) return;
    setMaxRunningText(String(config.maxRunningSandboxes));
    setWarnRunningText(String(config.warnRunningSandboxes));
    setDrainDeadlineText(String(config.drainDeadlineMs));
    setLocalError(null);
  }, [config]);
  const saveDraft = useCallback(async () => {
    try {
      setLocalError(null);
      const maxRunningSandboxes = parseLimit("最大运行环境数", maxRunningText);
      const warnRunningSandboxes = parseLimit("运行环境告警阈值", warnRunningText);
      const drainDeadlineMs = parseDuration(drainDeadlineText);
      if (maxRunningSandboxes > 0 && warnRunningSandboxes > maxRunningSandboxes) {
        throw new Error("运行环境告警阈值不能大于最大运行环境数");
      }
      const saved = await save({ maxRunningSandboxes, warnRunningSandboxes, drainDeadlineMs });
      setMaxRunningText(String(saved.maxRunningSandboxes));
      setWarnRunningText(String(saved.warnRunningSandboxes));
      setDrainDeadlineText(String(saved.drainDeadlineMs));
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }, [drainDeadlineText, maxRunningText, save, warnRunningText]);
  const discardDraft = useCallback(() => {
    if (!baseline) return;
    setMaxRunningText(String(baseline.maxRunningSandboxes));
    setWarnRunningText(String(baseline.warnRunningSandboxes));
    setDrainDeadlineText(String(baseline.drainDeadlineMs));
    setLocalError(null);
  }, [baseline]);
  useSettingsDirtyEntry({
    id: "platform-acs-runtime",
    label: "ACS 运行保护",
    dirty,
    save: saveDraft,
    discard: discardDraft,
    draft: { maxRunningSandboxes: maxRunningText, warnRunningSandboxes: warnRunningText, drainDeadlineMs: drainDeadlineText },
  });

  return (
    <Card data-testid="acs-runtime-settings">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base"><EntityIcons.admin className="size-4" />ACS 运行保护</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">限制同时运行的 ACS 环境数量，并设置告警阈值与排空超时。该配置独立保存到 ACS Orchestrator。</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {savedAt && !dirty && <Badge variant="secondary" className="gap-1"><CircleCheck className="size-3" />已保存</Badge>}
          {config?.persisted === false && <Badge variant="outline">未持久化</Badge>}
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading || saving || dirty}>
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            刷新
          </Button>
          <Button size="sm" onClick={() => { void saveDraft().catch(() => undefined); }} disabled={readOnly || loading || saving || !baseline}>
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
            保存 ACS 配置
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {(error || localError) && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{localError || error}</div>
        )}
        {loading && !config ? (
          <div className="flex h-24 items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" />加载 ACS 运行配置...</div>
        ) : (
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="acs-max-running">最大运行环境数</Label>
              <Input id="acs-max-running" inputMode="numeric" value={maxRunningText} onChange={(event) => { setMaxRunningText(event.target.value); setLocalError(null); }} disabled={readOnly || loading || saving || !baseline} />
              <p className="text-xs text-muted-foreground">0 表示不限制，最大 1000。</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="acs-warn-running">运行环境告警阈值</Label>
              <Input id="acs-warn-running" inputMode="numeric" value={warnRunningText} onChange={(event) => { setWarnRunningText(event.target.value); setLocalError(null); }} disabled={readOnly || loading || saving || !baseline} />
              <p className="text-xs text-muted-foreground">达到阈值时触发运行容量告警。</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="acs-drain-deadline">排空超时（毫秒）</Label>
              <Input id="acs-drain-deadline" inputMode="numeric" value={drainDeadlineText} onChange={(event) => { setDrainDeadlineText(event.target.value); setLocalError(null); }} disabled={readOnly || loading || saving || !baseline} />
              <p className="text-xs text-muted-foreground">允许范围 1000-86400000。</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
