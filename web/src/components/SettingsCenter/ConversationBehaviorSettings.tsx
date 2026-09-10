import { useCallback, useEffect, useState } from 'react';
import { Loader2, TriangleAlert } from 'lucide-react';
import { isDebugModeAvailable, saveUserPreferences } from '@agent/shared';

import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/contexts/AuthContext';
import { authFetch } from '@/lib/authFetch';
import { resolveApprovalTier } from '@/lib/approvalTier';
import { clearRunShellApprovalStorage } from '@/lib/runShellApprovalStorage';

const APPROVAL_OPTIONS = [
  {
    value: 'ask',
    title: '每次操作前询问',
    description: '除安全的只读操作外，执行前先询问。',
  },
  {
    value: 'low-risk',
    title: '自动执行低风险操作',
    description: '查询和低风险操作自动执行，高风险操作仍需确认。',
  },
  {
    value: 'full',
    title: '尽量自动执行',
    description: '除系统强制确认的操作外尽量自动执行。',
  },
] as const;

export function ConversationBehaviorSettings() {
  const { user, updatePreferences } = useAuth();
  const approvalTier = user ? resolveApprovalTier(user.preferences) : 'ask';
  const [approvalSaving, setApprovalSaving] = useState(false);
  const [approvalSaved, setApprovalSaved] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const changeApprovalTier = useCallback(
    async (next: 'ask' | 'low-risk' | 'full') => {
      if (next === approvalTier || approvalSaving) return;
      const previousPreferences = {
        authorizationModeEnabled: approvalTier === 'full',
        lowRiskToolsAutoApproveEnabled: approvalTier === 'low-risk',
      };
      const nextPreferences = {
        authorizationModeEnabled: next === 'full',
        lowRiskToolsAutoApproveEnabled: next === 'low-risk',
      };
      setApprovalSaving(true);
      setApprovalSaved(false);
      setApprovalError(null);
      updatePreferences(nextPreferences);
      if (next !== 'full') clearRunShellApprovalStorage();
      try {
        const saved = await saveUserPreferences(nextPreferences);
        if (!saved) throw new Error('保存失败');
        updatePreferences(saved);
        if (saved.authorizationModeEnabled !== true) clearRunShellApprovalStorage();
        setApprovalSaved(true);
        window.setTimeout(() => setApprovalSaved(false), 2000);
      } catch (error) {
        updatePreferences(previousPreferences);
        setApprovalError(error instanceof Error ? error.message : '保存失败');
      } finally {
        setApprovalSaving(false);
      }
    },
    [approvalSaving, approvalTier, updatePreferences],
  );

  return (
    <div className="space-y-6 border-t pt-5">
      <section aria-labelledby="operation-confirmation">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 id="operation-confirmation" className="text-sm font-semibold">
              操作前确认
            </h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              设置 Agent 使用工具执行操作前的确认方式，对 Web、移动端、钉钉和定时任务统一生效。
            </p>
          </div>
          {approvalSaving ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
          ) : approvalSaved ? (
            <span className="shrink-0 text-xs text-success">已保存</span>
          ) : null}
        </div>
        <div
          className="mt-3 grid gap-2 sm:grid-cols-3"
          role="radiogroup"
          aria-labelledby="operation-confirmation"
        >
          {APPROVAL_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={approvalTier === option.value}
              disabled={approvalSaving}
              onClick={() => {
                void changeApprovalTier(option.value);
              }}
              className={`rounded-xl border p-3 text-left text-sm transition-colors disabled:opacity-60 ${approvalTier === option.value ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'}`}
            >
              <div className="font-medium">{option.title}</div>
              <div className="mt-1 text-xs leading-5 text-muted-foreground">
                {option.description}
              </div>
            </button>
          ))}
        </div>
        {approvalError ? (
          <div className="mt-3 text-sm text-destructive" role="alert">
            {approvalError}
          </div>
        ) : null}
        <div className="mt-3 flex gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-muted-foreground">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-foreground" />
          <span>
            删除、付款、审批等重要操作仍可能要求你再次确认。选择“尽量自动执行”前，请确认符合你的使用习惯和安全要求。
          </span>
        </div>
      </section>

      <PersonalDebugModeSetting className="border-t pt-5" />
    </div>
  );
}

export function PersonalDebugModeSetting({ className = '', title = '显示详细执行过程' }: { className?: string; title?: string }) {
  const { user, updateDebugMode } = useAuth();
  const debugModeAvailable = user ? isDebugModeAvailable(user.tenantId, user.tenantFeatures) : false;
  const [debugMode, setDebugMode] = useState(user?.debugMode === true);
  const [debugModeSaving, setDebugModeSaving] = useState(false);
  const [debugModeError, setDebugModeError] = useState<string | null>(null);

  useEffect(() => {
    setDebugMode(user?.debugMode === true && debugModeAvailable);
  }, [debugModeAvailable, user?.debugMode]);

  const changeDebugMode = useCallback(async (next: boolean) => {
    setDebugModeSaving(true);
    setDebugModeError(null);
    try {
      const response = await authFetch('/api/auth/me/debug-mode', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ debugMode: next }),
      });
      const payload = (await response.json().catch(() => ({}))) as { debugMode?: boolean; error?: string };
      if (!response.ok) throw new Error(payload.error || `保存失败（HTTP ${response.status}）`);
      const effective = payload.debugMode === true;
      setDebugMode(effective);
      updateDebugMode(effective);
    } catch (error) {
      setDebugMode(user?.debugMode === true && debugModeAvailable);
      setDebugModeError(error instanceof Error ? error.message : '保存失败');
    } finally {
      setDebugModeSaving(false);
    }
  }, [debugModeAvailable, updateDebugMode, user?.debugMode]);

  const platformAllowed = user?.tenantFeatures?.debugModeAllowed === true;
  const organizationEnabled = user?.tenantFeatures?.debugModeEnabled === true;
  const unavailableGuidance = !platformAllowed
    ? '需要平台管理员先在“平台运营 → 组织 → 右上角组织配置 → 选择目标组织并进入配置 → 授权与配额”开启“调试模式授权”，再由组织管理员在“组织管理 → 功能与配额 → 功能开关”开启“成员调试模式”。'
    : !organizationEnabled
      ? '平台已授权；还需要组织管理员在“组织管理 → 功能与配额 → 功能开关”开启“成员调试模式”。'
      : null;

  return (
      <section className={className} aria-labelledby="detailed-execution-process">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="detailed-execution-process" className="text-sm font-semibold">
              {title}
            </h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              开启后显示 Agent 的思考摘要、工具调用和技能执行细节。
            </p>
            {!debugModeAvailable ? (
              <p className="mt-2 text-sm text-muted-foreground" role="note">
                {unavailableGuidance}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {debugModeSaving ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : null}
            <Switch
              checked={debugModeAvailable && debugMode}
              disabled={debugModeSaving || !debugModeAvailable}
              onCheckedChange={(next) => {
                void changeDebugMode(next);
              }}
              aria-label="显示详细执行过程"
            />
          </div>
        </div>
        {debugModeError ? (
          <div className="mt-3 text-sm text-destructive" role="alert">
            {debugModeError}
          </div>
        ) : null}
      </section>
  );
}
