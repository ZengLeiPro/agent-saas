import { useState } from 'react';
import { MoreHorizontal, PauseCircle, Archive } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { kyAppPost, KyAppManagementError } from '@/lib/kyAppManagementApi';
import type { SystemDetail } from '@/lib/kyAppManagementTypes';

export function SystemActions({ detail, reload }: { detail: SystemDetail; reload: () => void }) {
  const [action, setAction] = useState<'disabled' | 'retired' | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const actions = detail.allowedActions ?? [];
  if (!actions.includes('disable_system') && !actions.includes('retire_system')) return null;
  async function submit() {
    if (!action || busy || (action === 'retired' && confirmation !== detail.definition.name))
      return;
    setBusy(true);
    setError('');
    try {
      await kyAppPost(`/systems/${encodeURIComponent(detail.definition.systemId)}/status`, {
        status: action,
        expectedVersion: detail.definition.version,
      });
      setAction(null);
      reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败');
      if (reason instanceof KyAppManagementError && reason.status === 409) reload();
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" aria-label="更多系统操作">
            <MoreHorizontal className="mr-1 h-4 w-4" />
            更多操作
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          onCloseAutoFocus={(event) => {
            if (action) event.preventDefault();
          }}
        >
          {actions.includes('disable_system') && (
            <DropdownMenuItem
              onSelect={() => {
                setAction('disabled');
                setError('');
              }}
            >
              <PauseCircle className="mr-2 h-4 w-4" />
              停用系统
            </DropdownMenuItem>
          )}
          {actions.includes('retire_system') && (
            <DropdownMenuItem
              className="text-destructive"
              onSelect={() => {
                setAction('retired');
                setConfirmation('');
                setError('');
              }}
            >
              <Archive className="mr-2 h-4 w-4" />
              退役系统
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={action !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setAction(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {action === 'retired' ? '退役系统' : '停用系统'}：{detail.definition.name}
            </DialogTitle>
            <DialogDescription>
              {action === 'retired'
                ? '永久退出系统目录，不能恢复，也不能再发布版本或接入新组织。'
                : '暂停系统目录中的使用和新增组织接入；后续可重新发布版本恢复。'}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm">
            这是系统级操作，会影响所有已接入组织的工作区入口。仅需停用某个组织时，请到该组织的实例详情操作。
          </p>
          <p className="text-sm text-muted-foreground">
            此操作不删除外部业务数据，也不会停止外部服务器或代替逐个实例的凭据吊销。
          </p>
          {action === 'retired' && (
            <label className="block text-sm">
              输入系统名称确认
              <input
                aria-label="输入系统名称确认"
                value={confirmation}
                disabled={busy}
                onChange={(event) => setConfirmation(event.target.value)}
                className="mt-2 block w-full rounded border bg-background p-2"
              />
            </label>
          )}
          {error && <p role="alert">{error}</p>}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setAction(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={busy || (action === 'retired' && confirmation !== detail.definition.name)}
              onClick={() => void submit()}
            >
              {busy ? '处理中…' : action === 'retired' ? '确认退役' : '确认停用'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
