import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  deleteTenantPlatformSkillPresentation,
  SkillPresentationApiError,
  updatePlatformSkillPresentation,
  updateTenantOwnSkillPresentation,
  updateTenantPlatformSkillPresentation,
  type SkillInfo,
} from '@agent/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  skillDisplayName,
  skillDisplaySummary,
  skillPresentationRevision,
} from '@/lib/skillPresentation';

export interface SkillPresentationTarget {
  kind: 'platform' | 'tenant-platform' | 'tenant-own';
  skill: SkillInfo;
  tenantId?: string;
}

export function SkillPresentationDialog({
  target,
  disabled,
  onClose,
  onSaved,
}: {
  target: SkillPresentationTarget | null;
  disabled?: boolean;
  onClose(): void;
  onSaved(): Promise<void>;
}) {
  const [displayName, setDisplayName] = useState('');
  const [summary, setSummary] = useState('');
  const [baseline, setBaseline] = useState({ displayName: '', summary: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    const next = {
      displayName: skillDisplayName(target.skill),
      summary: skillDisplaySummary(target.skill),
    };
    setDisplayName(next.displayName);
    setSummary(next.summary);
    setBaseline(next);
    setError(null);
  }, [target]);

  const save = async () => {
    if (!target) return;
    const input = {
      displayName: displayName.trim(),
      summary: summary.trim(),
      expectedRevision: skillPresentationRevision(target.skill),
    };
    if (!input.displayName || !input.summary) {
      setError('展示名称和卡片简介不能为空');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (target.kind === 'platform') {
        await updatePlatformSkillPresentation(target.skill.id, input);
      } else if (target.kind === 'tenant-platform' && target.tenantId) {
        await updateTenantPlatformSkillPresentation(target.tenantId, target.skill.id, input);
      } else if (target.kind === 'tenant-own' && target.tenantId) {
        await updateTenantOwnSkillPresentation(target.tenantId, target.skill.id, input);
      } else {
        throw new Error('目标组织无效');
      }
      await onSaved();
      onClose();
    } catch (cause) {
      if (
        cause instanceof SkillPresentationApiError &&
        (cause.changed || cause.code === 'SKILL_PRESENTATION_VERSION_CONFLICT')
      ) {
        await onSaved().catch(() => undefined);
        onClose();
        window.alert(
          cause.changed
            ? '展示信息已更新，但治理审计结果异常。列表已刷新，请联系平台管理员核对审计记录。'
            : '展示信息已被其他管理员修改，列表已刷新，请重新打开后再编辑。',
        );
        return;
      }
      setError(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const restore = async () => {
    if (
      !target?.tenantId ||
      target.kind !== 'tenant-platform' ||
      target.skill.presentation?.source !== 'organization_override'
    )
      return;
    setSaving(true);
    setError(null);
    try {
      await deleteTenantPlatformSkillPresentation(
        target.tenantId,
        target.skill.id,
        skillPresentationRevision(target.skill),
      );
      await onSaved();
      onClose();
    } catch (cause) {
      if (
        cause instanceof SkillPresentationApiError &&
        (cause.changed || cause.code === 'SKILL_PRESENTATION_VERSION_CONFLICT')
      ) {
        await onSaved().catch(() => undefined);
        onClose();
        window.alert(
          cause.changed
            ? '平台默认已恢复，但治理审计结果异常。列表已刷新，请联系平台管理员核对审计记录。'
            : '展示信息已被其他管理员修改，列表已刷新，请重新打开后再操作。',
        );
        return;
      }
      setError(cause instanceof Error ? cause.message : '恢复失败');
    } finally {
      setSaving(false);
    }
  };

  const isOverride = target?.kind === 'tenant-platform';
  const dirty = displayName !== baseline.displayName || summary !== baseline.summary;
  const requestClose = () => {
    if (saving) return;
    if (dirty && !window.confirm('展示名称或简介尚未保存，确定放弃修改吗？')) return;
    onClose();
  };
  return (
    <Dialog
      open={Boolean(target)}
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
    >
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isOverride ? '设置组织内展示信息' : '编辑技能展示信息'}</DialogTitle>
          <DialogDescription>
            仅改变能力中心中的名称和简介，不修改 SKILL.md，也不影响 Agent 的执行规则。
            {isOverride
              ? target?.skill.presentation?.source === 'organization_override'
                ? ' 当前使用组织自定义展示。'
                : ' 当前继承平台默认，保存后将创建本组织专属展示。'
              : null}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            技术标识：{target?.skill.id}
          </div>
          <label className="grid gap-1.5 text-sm font-medium">
            展示名称
            <input
              className="h-10 rounded-md border bg-background px-3 font-normal outline-none focus:ring-2 focus:ring-ring"
              value={displayName}
              maxLength={80}
              onChange={(event) => setDisplayName(event.target.value)}
              disabled={saving || disabled}
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            卡片简介
            <textarea
              className="min-h-24 rounded-md border bg-background px-3 py-2 font-normal outline-none focus:ring-2 focus:ring-ring"
              value={summary}
              maxLength={240}
              onChange={(event) => setSummary(event.target.value)}
              disabled={saving || disabled}
            />
            <span className="text-right text-xs font-normal text-muted-foreground">
              {summary.length}/240
            </span>
          </label>
          {error ? (
            <div role="alert" className="text-sm text-destructive">
              {error}
            </div>
          ) : null}
        </div>
        <DialogFooter className="sm:justify-between">
          <div>
            {target?.kind === 'tenant-platform' &&
            target.skill.presentation?.source === 'organization_override' ? (
              <Button
                variant="ghost"
                onClick={() => {
                  void restore();
                }}
                disabled={saving || disabled}
              >
                恢复平台默认
              </Button>
            ) : null}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={requestClose} disabled={saving}>
              取消
            </Button>
            <Button
              onClick={() => {
                void save();
              }}
              disabled={saving || disabled || !displayName.trim() || !summary.trim()}
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : null}
              保存
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
