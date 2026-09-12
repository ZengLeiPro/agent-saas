import { useState } from 'react';
import { Pencil } from 'lucide-react';

import type { ProviderQuotaSnapshot } from '@agent/shared';
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

export const PROVIDER_QUOTA_NOTE_STORAGE_KEY = 'platform-console.provider-quota.notes.v1';

function readNotes(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PROVIDER_QUOTA_NOTE_STORAGE_KEY) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  } catch {
    return {};
  }
}

function writeNotes(notes: Record<string, string>): void {
  try {
    if (Object.keys(notes).length === 0) {
      localStorage.removeItem(PROVIDER_QUOTA_NOTE_STORAGE_KEY);
    } else {
      localStorage.setItem(PROVIDER_QUOTA_NOTE_STORAGE_KEY, JSON.stringify(notes));
    }
  } catch {
    // 本地存储不可用时仍保留当前页面内的备注。
  }
}

export function ProviderQuotaNoteEditor({ accountKey, accountLabel }: {
  accountKey: ProviderQuotaSnapshot['accountKey'];
  accountLabel: string;
}) {
  const [note, setNote] = useState(() => readNotes()[accountKey] ?? '');
  const [draft, setDraft] = useState(note);
  const [open, setOpen] = useState(false);

  const openEditor = () => {
    setDraft(note);
    setOpen(true);
  };

  const save = () => {
    const nextNote = draft.trim();
    const notes = readNotes();
    if (nextNote) {
      notes[accountKey] = nextNote;
    } else {
      delete notes[accountKey];
    }
    writeNotes(notes);
    setNote(nextNote);
    setOpen(false);
  };

  return (
    <>
      <span className="inline-flex min-w-0 max-w-40 items-center gap-1">
        <button
          type="button"
          aria-label={`编辑 ${accountLabel} 备注`}
          title="编辑备注"
          className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={openEditor}
        >
          <Pencil className="size-3" aria-hidden="true" />
        </button>
        {note && (
          <span className="min-w-0 truncate text-xs text-muted-foreground" title={note}>
            {note}
          </span>
        )}
      </span>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>套餐备注</DialogTitle>
            <DialogDescription>{accountLabel}</DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label="备注内容"
            value={draft}
            placeholder="填写备注"
            onChange={(event) => setDraft(event.target.value)}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button type="button" onClick={save}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
