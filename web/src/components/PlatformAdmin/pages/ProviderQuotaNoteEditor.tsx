import { useState } from 'react';
import { Pencil } from 'lucide-react';

import type { ProviderQuotaOverviewResponse, ProviderQuotaSnapshot } from '@agent/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';

import { platformAdminApi } from '../api';

export function ProviderQuotaNoteEditor({
  snapshot,
  onSaved,
}: {
  snapshot: ProviderQuotaSnapshot;
  onSaved: (overview: ProviderQuotaOverviewResponse) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = snapshot.planExpiry;
  const note = snapshot.planExpiry?.note ?? '';

  async function save() {
    setSaving(true);
    setError(null);
    try {
      onSaved(await platformAdminApi.setProviderPlanNote(snapshot.accountKey, draft.trim() || null));
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请重试');
    } finally {
      setSaving(false);
    }
  }

  if (!state?.editable) return null;

  return (
    <>
      <span className="inline-flex min-w-0 max-w-40 items-center gap-1">
        <button
          type="button"
          aria-label={`编辑 ${snapshot.accountLabel} 备注`}
          title="编辑备注"
          className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={() => {
            setDraft(note);
            setError(null);
            setOpen(true);
          }}
        >
          <Pencil className="size-3" aria-hidden="true" />
        </button>
        {note && (
          <span className="min-w-0 truncate text-xs text-muted-foreground" title={note}>
            {note}
          </span>
        )}
      </span>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!saving) setOpen(next);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>套餐备注</DialogTitle>
            <DialogDescription>{snapshot.accountLabel}</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <Textarea
              aria-label="备注内容"
              value={draft}
              disabled={saving}
              placeholder="填写备注"
              onChange={(event) => setDraft(event.target.value)}
            />
            {error && (
              <p role="alert" className="text-xs text-danger-ink">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={saving} onClick={() => setOpen(false)}>
                取消
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
