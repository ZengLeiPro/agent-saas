import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { kyAppPost } from '@/lib/kyAppManagementApi';
export function InstallSystemWizard({
  tenantId,
  systemId,
  onInstalled,
}: {
  tenantId: string;
  systemId: string;
  onInstalled: (id: string) => void;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingData, setPendingData] = useState<Record<string, FormDataEntryValue> | null>(null);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setPendingData(Object.fromEntries(new FormData(event.currentTarget)));
  }
  async function confirmInstall() {
    if (!pendingData || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await kyAppPost<{ installation: { installationId: string } }>(
        '/installations',
        { ...pendingData, tenantId, systemId },
      );
      setPendingData(null);
      onInstalled(result.installation.installationId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '安装失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <form className="space-y-3 rounded border p-4" onSubmit={submit}>
        <h3 className="font-medium">安装 {systemId}</h3>
        {[
          ['installationId', '安装实例标识'],
          ['baseUrl', '业务服务地址'],
          ['origin', '业务页面地址'],
          ['techContactUserId', '本组织技术联系人用户 ID'],
        ].map(([name, label]) => (
          <label key={name} className="block text-sm">
            {label}
            <input
              name={name}
              required
              disabled={busy}
              type={name === 'baseUrl' || name === 'origin' ? 'url' : 'text'}
              className="mt-1 block w-full rounded border bg-background p-2"
            />
          </label>
        ))}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button disabled={busy}>{busy ? '创建中…' : '创建安装实例'}</Button>
      </form>
      <Dialog
        open={pendingData !== null}
        onOpenChange={(open) => !open && !busy && setPendingData(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认创建安装实例</DialogTitle>
            <DialogDescription>
              将在当前组织创建“{systemId}”安装实例，创建后需要由技术联系人完成装配。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setPendingData(null)}>
              取消
            </Button>
            <Button disabled={busy} onClick={() => void confirmInstall()}>
              {busy ? '创建中…' : '确认创建'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
