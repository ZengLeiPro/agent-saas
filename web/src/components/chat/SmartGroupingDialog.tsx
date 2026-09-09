import { useMemo, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';

import {
  applySmartGroupingPlan,
  generateSmartGroupingPlan,
  type SmartGroupingPlan,
  type SmartGroupingScope,
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

export function SmartGroupingDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApplied: () => void | Promise<void>;
}) {
  const [scope, setScope] = useState<SmartGroupingScope>('ungrouped');
  const [plan, setPlan] = useState<SmartGroupingPlan | null>(null);
  const [busy, setBusy] = useState<'plan' | 'apply' | null>(null);
  const [error, setError] = useState('');
  const titles = useMemo(
    () => new Map(plan?.sessions.map((session) => [session.sessionId, session.title]) ?? []),
    [plan],
  );

  const close = (open: boolean) => {
    props.onOpenChange(open);
    if (!open) {
      setPlan(null);
      setError('');
      setBusy(null);
    }
  };

  const generate = async () => {
    setBusy('plan');
    setError('');
    setPlan(null);
    try {
      setPlan(await generateSmartGroupingPlan(scope));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '智能分组生成失败');
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!plan) return;
    setBusy('apply');
    setError('');
    try {
      await applySmartGroupingPlan(plan);
      await props.onApplied();
      close(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '智能分组应用失败');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={close}>
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-5 text-primary" />
            智能分组
          </DialogTitle>
          <DialogDescription>
            Agent 根据会话内容生成整理方案，确认前不会修改现有分组。
          </DialogDescription>
        </DialogHeader>
        {!plan ? (
          <div className="space-y-3 py-2">
            {(
              [
                ['ungrouped', '仅整理未分组会话', '保留当前所有分组，是更稳妥的默认方式。'],
                ['all', '重新整理普通会话', '允许调整已有手动分组中的普通会话。'],
              ] as const
            ).map(([value, label, description]) => (
              <label key={value} className="flex cursor-pointer gap-3 rounded-xl border p-4">
                <input
                  type="radio"
                  name="smart-grouping-scope"
                  value={value}
                  checked={scope === value}
                  onChange={() => setScope(value)}
                />
                <span>
                  <span className="block text-sm font-medium">{label}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">{description}</span>
                </span>
              </label>
            ))}
          </div>
        ) : (
          <div className="min-h-0 space-y-3 overflow-auto py-2">
            {plan.truncated && (
              <div className="rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">
                本次整理最近 100 个会话，更早会话未被修改。
              </div>
            )}
            {plan.groups.length === 0 && (
              <div className="rounded-lg bg-muted p-4 text-center text-sm text-muted-foreground">
                没有生成可应用的分组建议。
              </div>
            )}
            {plan.groups.map((group) => (
              <div key={group.name} className="rounded-xl border p-3">
                <div className="mb-2 text-sm font-semibold">
                  {group.name}
                  <span className="ml-1 font-normal text-muted-foreground">
                    ({group.sessionIds.length})
                  </span>
                </div>
                <div className="space-y-1">
                  {group.sessionIds.map((sessionId) => (
                    <div
                      key={sessionId}
                      className="truncate rounded-md bg-muted/50 px-2 py-1.5 text-sm"
                    >
                      {titles.get(sessionId) ?? sessionId}
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {plan.ungroupedSessionIds.length > 0 && (
              <div className="text-xs text-muted-foreground">
                保留未分组：{plan.ungroupedSessionIds.length} 个会话
              </div>
            )}
          </div>
        )}
        {error && (
          <div
            role="alert"
            className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </div>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => close(false)}
            disabled={busy !== null}
          >
            取消
          </Button>
          {!plan ? (
            <Button type="button" onClick={() => void generate()} disabled={busy !== null}>
              {busy === 'plan' ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Sparkles className="size-4" />
              )}
              生成分组方案
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => setPlan(null)}
                disabled={busy !== null}
              >
                重新生成
              </Button>
              <Button
                type="button"
                onClick={() => void apply()}
                disabled={busy !== null || plan.groups.length === 0}
              >
                {busy === 'apply' && <Loader2 className="size-4 animate-spin" />}确认应用
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SmartGroupingButton(props: {
  onApplied: () => void | Promise<void>;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={props.compact ? 'size-7' : 'size-8'}
        title="智能分组"
        aria-label="智能分组"
        onClick={() => setOpen(true)}
      >
        <Sparkles className="size-4" />
      </Button>
      <SmartGroupingDialog open={open} onOpenChange={setOpen} onApplied={props.onApplied} />
    </>
  );
}
