import { useState } from 'react';
import { Pencil } from 'lucide-react';
import type { ProviderQuotaOverviewResponse, ProviderQuotaSnapshot } from '@agent/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { platformAdminApi } from '../api';

/** datetime-local 的值固定解释为北京时间，不依赖操作系统时区。 */
export function toBeijingInput(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 16);
}

export function fromBeijingInput(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(`${value}:00+08:00`);
  if (!Number.isFinite(date.getTime()) || toBeijingInput(date.toISOString()) !== value) return null;
  return date.toISOString();
}

function displayTime(value: string): string {
  return toBeijingInput(value).slice(5).replace('-', '/').replace('T', ' ');
}

export function ProviderPlanExpiryEditor({
  snapshot,
  onSaved,
}: {
  snapshot: ProviderQuotaSnapshot;
  onSaved: (overview: ProviderQuotaOverviewResponse) => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = snapshot.planExpiry;
  const expiry = state?.endTime ?? snapshot.plan?.endTime;
  const label = expiry ? `套餐到期 ${displayTime(expiry)}` : '设置套餐到期';

  async function save(clear = false) {
    const endTime = clear ? null : fromBeijingInput(value);
    if (!clear && !endTime) {
      setError('请选择有效的日期和时间');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      onSaved(await platformAdminApi.setProviderPlanExpiry(snapshot.accountKey, endTime));
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请重试');
    } finally {
      setSaving(false);
    }
  }

  if (!state?.editable) return expiry ? <span>{label}</span> : null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!saving) setOpen(next);
      }}
    >
      <button
        type="button"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        aria-label={`编辑 ${snapshot.accountLabel} 套餐到期时间`}
        title={`${state.manualEndTime ? '手动设置' : '编辑套餐到期'} · 北京时间`}
        onClick={() => {
          setValue(toBeijingInput(expiry));
          setError(null);
          setOpen(true);
        }}
      >
        {label}
        <Pencil className="size-3" />
      </button>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>套餐到期时间</DialogTitle>
          <DialogDescription>{snapshot.accountLabel} · 北京时间</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          className="space-y-4"
        >
          <label className="block space-y-2 text-sm">
            <span>到期时间</span>
            <Input
              type="datetime-local"
              step="60"
              value={value}
              disabled={saving}
              onChange={(event) => setValue(event.target.value)}
              required
            />
          </label>
          {state.providerEndTime && (
            <p className="text-xs text-muted-foreground">
              供应商时间：{displayTime(state.providerEndTime)}
            </p>
          )}
          {error && (
            <p role="alert" className="text-xs text-danger-ink">
              {error}
            </p>
          )}
          <DialogFooter>
            {state.manualEndTime && (
              <Button
                type="button"
                variant="ghost"
                disabled={saving}
                onClick={() => void save(true)}
              >
                清除手动设置
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => setOpen(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={saving || !value}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
