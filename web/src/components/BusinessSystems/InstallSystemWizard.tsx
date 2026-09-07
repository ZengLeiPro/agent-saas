import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
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
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = Object.fromEntries(new FormData(event.currentTarget));
    if (!window.confirm('确认在当前组织创建此业务系统安装实例？创建后需由技术联系人完成装配。'))
      return;
    setBusy(true);
    setError('');
    try {
      const result = await kyAppPost<{ installation: { installationId: string } }>(
        '/installations',
        { ...data, tenantId, systemId },
      );
      onInstalled(result.installation.installationId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '安装失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="space-y-3 rounded border p-4" onSubmit={(event) => void submit(event)}>
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
  );
}
