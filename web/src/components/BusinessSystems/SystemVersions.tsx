import { ManifestDiff } from './ManifestDiff';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
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

export function PublishVersionAction({
  detail,
  digest,
  reload,
}: {
  detail: SystemDetail;
  digest?: string;
  reload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  async function publish() {
    if (busy || !digest) return;
    setBusy(true);
    setError('');
    try {
      await kyAppPost(
        `/systems/${encodeURIComponent(detail.definition.systemId)}/versions/${digest}/publish`,
        { expectedVersion: detail.definition.version },
      );
      setOpen(false);
      reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败');
      if (reason instanceof KyAppManagementError && reason.status === 409) reload();
    } finally {
      setBusy(false);
    }
  }
  const restoring = detail.definition.status === 'disabled';
  return (
    <>
      <Button
        disabled={!digest || busy}
        title={digest ? undefined : '暂无待发布版本'}
        onClick={() => setOpen(true)}
      >
        {restoring ? '重新发布并恢复系统' : '发布版本'}
      </Button>
      <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{restoring ? '重新发布并恢复系统' : '发布业务系统版本'}</DialogTitle>
            <DialogDescription>
              {restoring
                ? '系统目录将恢复可用；各组织仍需完成对应版本的部署与验证。'
                : '发布后，现有组织实例仍需部署并验证该版本，平台不会自动切换运行版本。'}
            </DialogDescription>
          </DialogHeader>
          <p className="break-all rounded-lg bg-muted p-3 font-mono text-xs">{digest}</p>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button disabled={busy} onClick={() => void publish()}>
              {busy ? '发布中…' : '确认发布'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function SystemVersions({ detail }: { detail: SystemDetail }) {
  return (
    <section className="space-y-3">
      <h3 className="font-medium">系统版本</h3>
      {detail.versions.length === 0 && <p>暂无登记版本</p>}
      {detail.versions.map((version) => (
        <article key={version.digest} className="space-y-3 rounded-lg border p-4">
          <div className="flex flex-wrap items-center gap-3">
            <strong>
              {version.status === 'published'
                ? '已发布'
                : version.status === 'retired'
                  ? '已退役'
                  : '已登记'}
            </strong>
            <code className="break-all text-xs">{version.digest}</code>
          </div>
          <p className="text-sm">登记人：{version.createdBy}</p>
          {version.reviewReasons.length > 0 && (
            <div>
              <h4 className="text-sm font-medium">版本变化提示</h4>
              <ul className="list-inside list-disc text-sm">
                {version.reviewReasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          )}
          <ManifestDiff
            before={
              detail.versions.find((item) => item.digest === detail.definition.publishedDigest)
                ?.manifest
            }
            after={version.manifest}
          />
          <details>
            <summary className="cursor-pointer text-sm">查看只读 Manifest</summary>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">
              {JSON.stringify(version.manifest, null, 2)}
            </pre>
          </details>
        </article>
      ))}
    </section>
  );
}
