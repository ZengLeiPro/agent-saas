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
  const [input, setInput] = useState<Record<string, unknown>>(
    initial.settings.diagnostic?.readOnlyInput ?? {},
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
      await kyAppPost(path, {
        expectedVersion: initial.version,
        settings: {
          baseUrl: baseUrl.trim(),
          origin: origin.trim(),
          ...(capability
            ? { diagnostic: { readOnlyCapabilityId: capability, readOnlyInput: input } }
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
          <DiagnosticInputFields
            schema={manifest?.capabilities.find((item) => item.id === capability)?.inputSchema}
            value={input}
            disabled={busy}
            onChange={setInput}
          />
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

function DiagnosticInputFields({
  schema,
  value,
  disabled,
  onChange,
}: {
  schema: Record<string, unknown> | undefined;
  value: Record<string, unknown>;
  disabled: boolean;
  onChange: (value: Record<string, unknown>) => void;
}) {
  const properties =
    schema && typeof schema.properties === 'object' && schema.properties !== null
      ? (schema.properties as Record<string, Record<string, unknown>>)
      : {};
  const required = new Set(
    Array.isArray(schema?.required)
      ? schema.required.filter((item): item is string => typeof item === 'string')
      : [],
  );
  if (Object.keys(properties).length === 0)
    return <p className="text-sm text-muted-foreground">此能力不需要诊断参数。</p>;
  return (
    <div className="grid gap-3 rounded border p-3">
      <p className="text-sm font-medium">诊断参数</p>
      {Object.entries(properties).map(([key, field]) => {
        const label = typeof field.description === 'string' ? field.description : key;
        const options = Array.isArray(field.enum) ? field.enum : null;
        if (
          !options &&
          field.type !== 'string' &&
          field.type !== 'number' &&
          field.type !== 'integer' &&
          field.type !== 'boolean'
        )
          return null;
        const update = (next: unknown) => onChange({ ...value, [key]: next });
        if (field.type === 'boolean')
          return (
            <label key={key} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={value[key] === true}
                disabled={disabled}
                onChange={(event) => update(event.target.checked)}
              />
              {label}
            </label>
          );
        if (options)
          return (
            <label key={key} className="text-sm">
              {label}
              <select
                required={required.has(key)}
                value={String(value[key] ?? '')}
                disabled={disabled}
                onChange={(event) => update(event.target.value)}
                className="mt-1 block w-full rounded border bg-background p-2"
              >
                <option value="">请选择</option>
                {options.map((option) => (
                  <option key={String(option)} value={String(option)}>
                    {String(option)}
                  </option>
                ))}
              </select>
            </label>
          );
        const numeric = field.type === 'number' || field.type === 'integer';
        return (
          <label key={key} className="text-sm">
            {label}
            <input
              type={numeric ? 'number' : 'text'}
              required={required.has(key)}
              value={String(value[key] ?? '')}
              disabled={disabled}
              onChange={(event) =>
                update(
                  numeric && event.target.value !== ''
                    ? Number(event.target.value)
                    : event.target.value,
                )
              }
              className="mt-1 block w-full rounded border bg-background p-2"
            />
          </label>
        );
      })}
    </div>
  );
}
