import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { kyAppPost, KyAppManagementError } from '@/lib/kyAppManagementApi';
import type { SystemDetail } from '@/lib/kyAppManagementTypes';
export function SystemVersions({ detail, reload }: { detail: SystemDetail; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function act(digest: string, action: 'review' | 'publish') {
    if (
      busy ||
      !window.confirm(
        action === 'review'
          ? '确认已复核此版本的能力和访问范围变化？'
          : '确认发布此版本？现有实例需部署并验证后才能切换。',
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      await kyAppPost(
        `/systems/${encodeURIComponent(detail.definition.systemId)}/versions/${digest}/${action}`,
        action === 'publish' ? { expectedVersion: detail.definition.version } : {},
      );
      reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败');
      if (reason instanceof KyAppManagementError && reason.status === 409) reload();
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-3">
      <h3 className="font-medium">系统版本</h3>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {detail.versions.length === 0 && <p>暂无登记版本</p>}
      {detail.versions.map((version) => (
        <article key={version.digest} className="space-y-3 rounded-lg border p-4">
          <div className="flex flex-wrap items-center gap-3">
            <strong>
              {version.status === 'published'
                ? '已发布'
                : version.reviewStatus === 'pending'
                  ? '待复核'
                  : version.reviewStatus === 'approved'
                    ? '已复核'
                    : '已登记'}
            </strong>
            <code className="break-all text-xs">{version.digest}</code>
          </div>
          <p className="text-sm">登记人：{version.createdBy}</p>
          {version.reviewReasons.length > 0 && (
            <div>
              <h4 className="text-sm font-medium">语义变化与复核原因</h4>
              <ul className="list-inside list-disc text-sm">
                {version.reviewReasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          )}
          <details>
            <summary className="cursor-pointer text-sm">查看只读 Manifest</summary>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">
              {JSON.stringify(version.manifest, null, 2)}
            </pre>
          </details>
          <div className="flex gap-2">
            {version.allowedActions?.includes('review_version') && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void act(version.digest, 'review')}
              >
                复核版本
              </Button>
            )}
            {version.allowedActions?.includes('publish_version') &&
              detail.definition.publishedDigest !== version.digest && (
                <Button disabled={busy} onClick={() => void act(version.digest, 'publish')}>
                  发布版本
                </Button>
              )}
          </div>
        </article>
      ))}
    </section>
  );
}
