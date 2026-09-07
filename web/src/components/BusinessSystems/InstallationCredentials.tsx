import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { installationPath, kyAppPost } from '@/lib/kyAppManagementApi';
import type { CredentialMetadata, CredentialTicket } from '@/lib/kyAppManagementTypes';
import { credentialClaimUrl } from '../KyAppCredentialClaim/claimRoute';
import { useManagementResource, ResourceState } from './ManagementResource';
export function InstallationCredentials({
  installationId,
  canIssue,
}: {
  installationId: string;
  canIssue: boolean;
}) {
  const resource = useManagementResource<{ credentials: CredentialMetadata[] }>(
    installationPath(installationId, '/credentials'),
  );
  const [ticket, setTicket] = useState<CredentialTicket>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!resource.data?.credentials.some((item) => item.status === 'pending_ack')) return;
    const timer = window.setTimeout(resource.reload, 10000);
    return () => window.clearTimeout(timer);
  }, [resource.data, resource.reload]);
  async function issue() {
    if (
      busy ||
      !window.confirm('确认签发新凭据？技术联系人完成领取、装配与确认后，旧服务凭据将被吊销。')
    )
      return;
    setBusy(true);
    setError('');
    try {
      setTicket(
        (
          await kyAppPost<{ credential: CredentialTicket }>(
            installationPath(installationId, '/credentials'),
          )
        ).credential,
      );
      resource.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '签发失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-3">
      <h3 className="font-medium">凭据与轮换</h3>
      <p className="text-sm">管理员只能查看生命周期信息。凭据明文由登记的技术联系人一次性领取。</p>
      {!resource.data ? (
        <ResourceState error={resource.error} retry={resource.reload} />
      ) : (
        <ul>
          {!resource.data.credentials.length && <li>尚未签发凭据</li>}
          {resource.data.credentials.map((item) => (
            <li className="border-b py-2 text-sm" key={item.credentialId}>
              {item.credentialId} · {item.status}
              <p>
                到期：{item.expiresAt} · 确认：{item.ackedAt ?? '待确认'} · 吊销：
                {item.revokedAt ?? '未吊销'}
              </p>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        {canIssue && (
          <Button disabled={busy} onClick={() => void issue()}>
            {busy ? '签发中…' : '签发 / 轮换凭据'}
          </Button>
        )}
        <Button variant="outline" onClick={resource.reload}>
          刷新凭据状态
        </Button>
      </div>
      {error && <p role="alert">{error}</p>}
      {ticket && (
        <div>
          <p>技术联系人领取链接（{ticket.ticketExpiresAt} 前有效）</p>
          <input
            className="w-full rounded border bg-background p-2 text-xs"
            aria-label="技术联系人领取链接"
            readOnly
            value={credentialClaimUrl(installationId, ticket.ticket)}
          />
        </div>
      )}
    </section>
  );
}
