import { useState } from 'react';
import type { ProviderQuotaOverviewResponse, ProviderQuotaSnapshot } from '@agent/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
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

function MetaDisplay({
  expiryLabel,
  note,
  placeholder,
}: {
  expiryLabel: string | null;
  note: string;
  placeholder?: string;
}) {
  if (!expiryLabel && !note) {
    return placeholder ? <span>{placeholder}</span> : null;
  }
  return (
    <>
      {expiryLabel && <span className="whitespace-nowrap text-xs font-normal tabular-nums">{expiryLabel}</span>}
      {note && (
        <span className="min-w-0 truncate" title={note}>
          {note}
        </span>
      )}
    </>
  );
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
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = snapshot.planExpiry;
  const expiry = state?.endTime ?? snapshot.plan?.endTime;
  const currentNote = state?.note ?? '';
  const expiryLabel = expiry ? `到期 ${displayTime(expiry)}` : null;

  async function save(clear = false) {
    const endTime = clear ? null : value ? fromBeijingInput(value) : null;
    if (!clear && value && !endTime) {
      setError('请选择有效的日期和时间');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      let overview: ProviderQuotaOverviewResponse | undefined;
      if (clear || value) {
        overview = await platformAdminApi.setProviderPlanExpiry(snapshot.accountKey, endTime);
      }
      overview = await platformAdminApi.setProviderPlanNote(snapshot.accountKey, note.trim() || null);
      onSaved(overview);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请重试');
    } finally {
      setSaving(false);
    }
  }

  const display = (
    <span className="inline-flex min-w-0 max-w-full items-center gap-4 text-xs font-normal text-muted-foreground">
      <MetaDisplay expiryLabel={expiryLabel} note={currentNote} placeholder={state?.editable ? '设置到期与备注' : undefined} />
    </span>
  );

  if (!state?.editable) return expiryLabel || currentNote ? display : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!saving) setOpen(next);
      }}
    >
      <button
        type="button"
        className="inline-flex min-w-0 max-w-full items-center rounded-md text-left text-xs font-normal text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`编辑 ${snapshot.accountLabel} 到期时间与备注`}
        title={`${state.manualEndTime ? '手动设置' : '编辑套餐到期与备注'} · 北京时间`}
        onClick={() => {
          setValue(toBeijingInput(expiry));
          setNote(currentNote);
          setError(null);
          setOpen(true);
        }}
      >
        {display}
      </button>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>套餐到期与备注</DialogTitle>
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
            />
          </label>
          <label className="block space-y-2 text-sm">
            <span>备注</span>
            <Textarea
              aria-label="备注内容"
              value={note}
              disabled={saving}
              placeholder="填写备注"
              onChange={(event) => setNote(event.target.value)}
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
            <Button type="submit" disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
