import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { kyAppPost } from '@/lib/kyAppManagementApi';
import type { SystemDetail } from '@/lib/kyAppManagementTypes';
import type { ConnectionSettingsRecord } from '@/lib/kyAppConnectionTypes';
import { useManagementResource, ResourceState } from './ManagementResource';

export function SystemConnectionSettings({
  detail,
  onSaved,
}: {
  detail: SystemDetail;
  onSaved: () => void;
}) {
  const path = `/systems/${encodeURIComponent(detail.definition.systemId)}/connection-settings`;
  const resource = useManagementResource<ConnectionSettingsRecord>(path);
  if (!resource.data) return <ResourceState error={resource.error} retry={resource.reload} />;
  return (
    <SettingsForm
      key={resource.data.version}
      initial={resource.data}
      detail={detail}
      path={path}
      onRefresh={resource.reload}
      onSaved={() => {
        resource.reload();
        onSaved();
      }}
    />
  );
}
function SettingsForm({
  initial,
  detail,
  path,
  onSaved,
  onRefresh,
}: {
  initial: ConnectionSettingsRecord;
  detail: SystemDetail;
  path: string;
  onSaved: () => void;
  onRefresh: () => void;
}) {
  const [baseUrl, setBaseUrl] = useState(initial.settings.baseUrl);
  const [origin, setOrigin] = useState(initial.settings.origin);
  const [capability, setCapability] = useState(
    initial.settings.diagnostic?.readOnlyCapabilityId ?? '',
  );
  const [input, setInput] = useState(
    JSON.stringify(initial.settings.diagnostic?.readOnlyInput ?? {}, null, 2),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const manifest = detail.versions.find(
    (version) => version.digest === detail.definition.publishedDigest,
  )?.manifest;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const parsed = capability ? JSON.parse(input) : undefined;
      if (capability && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)))
        throw new Error('诊断参数必须是 JSON 对象');
      await kyAppPost(path, {
        expectedVersion: initial.version,
        settings: {
          baseUrl: baseUrl.trim(),
          origin: origin.trim(),
          ...(capability
            ? { diagnostic: { readOnlyCapabilityId: capability, readOnlyInput: parsed } }
            : {}),
        },
      });
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4 rounded border p-4">
      <h3 className="font-medium">默认接入配置</h3>
      <p className="text-sm text-muted-foreground">
        维护一次，组织接入时自动带入。独立部署可使用 {'{tenantId}'}、{'{systemId}'}{' '}
        地址占位符，或接入时填写地址。保存不会改变已有安装实例。
      </p>
      <label className="block text-sm">
        默认业务服务地址
        <input
          value={baseUrl}
          disabled={busy}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="https://{tenantId}.apps.kaiyancn.com"
          className="mt-1 block w-full rounded border bg-background p-2"
        />
      </label>
      <label className="block text-sm">
        默认业务页面地址
        <input
          value={origin}
          disabled={busy}
          onChange={(event) => setOrigin(event.target.value)}
          placeholder="https://{tenantId}.apps.kaiyancn.com"
          className="mt-1 block w-full rounded border bg-background p-2"
        />
      </label>
      <details className="space-y-3">
        <summary className="cursor-pointer text-sm">接入诊断配置</summary>
        <p className="text-xs text-muted-foreground">
          选择只读能力和不含敏感信息的业务参数，接入后在“运行与诊断”中验证。
        </p>
        <label className="block text-sm">
          诊断能力
          <select
            value={capability}
            disabled={busy}
            onChange={(event) => setCapability(event.target.value)}
            className="ml-2 rounded border bg-background p-2"
          >
            <option value="">暂不配置</option>
            {manifest?.capabilities
              .filter((item) => item.riskLevel === 'read_only')
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
          </select>
        </label>
        {capability && (
          <label className="block text-sm">
            诊断参数（JSON）
            <textarea
              value={input}
              disabled={busy}
              onChange={(event) => setInput(event.target.value)}
              rows={5}
              className="mt-1 block w-full rounded border bg-background p-2 font-mono text-xs"
            />
          </label>
        )}
      </details>
      {error && (
        <div role="alert">
          <p>{error}</p>
          <Button type="button" variant="link" onClick={onRefresh}>
            重新加载已保存配置
          </Button>
        </div>
      )}
      <Button disabled={busy || detail.definition.status === 'retired'}>
        {busy ? '保存中…' : '保存接入配置'}
      </Button>
    </form>
  );
}
