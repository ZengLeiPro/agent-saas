import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { kyAppPost, type SystemDefinition } from '@/lib/kyAppManagementApi';
import type { OnboardRequest, OnboardResponse, SystemDetail } from '@/lib/kyAppManagementTypes';
import { useManagementResource, ResourceState } from '../BusinessSystems/ManagementResource';
const fields = [
  ['tenantId', '组织标识'],
  ['tenantName', '组织名称'],
  ['adminName', '组织管理员姓名'],
  ['adminPhone', '管理员手机号'],
  ['techContactPhone', '技术联系人手机号'],
  ['installationId', '安装实例标识'],
  ['baseUrl', '业务服务地址'],
  ['origin', '业务页面地址'],
] as const;
export function CreateDeliveryForm({
  defaultSystemId = '',
  onStarted,
}: {
  defaultSystemId?: string;
  onStarted: (result: OnboardResponse) => void;
}) {
  const systems = useManagementResource<{ systems: SystemDefinition[]; allowedActions?: string[] }>(
    '/systems',
  );
  const [systemId, setSystemId] = useState(defaultSystemId);
  if (!systems.data) return <ResourceState error={systems.error} retry={systems.reload} />;
  return (
    <section className="space-y-4">
      <h3 className="font-medium">新建组织交付</h3>
      <label className="block text-sm">
        已发布系统
        <select
          className="ml-3 rounded border p-2"
          value={systemId}
          onChange={(event) => setSystemId(event.target.value)}
        >
          <option value="">选择业务系统</option>
          {systems.data.systems
            .filter((system) => system.allowedActions?.includes('start_delivery'))
            .map((system) => (
              <option key={system.systemId} value={system.systemId}>
                {system.name}
              </option>
            ))}
        </select>
      </label>
      {systemId && <DeliveryFields key={systemId} systemId={systemId} onStarted={onStarted} />}
    </section>
  );
}
function DeliveryFields({
  systemId,
  onStarted,
}: {
  systemId: string;
  onStarted: (result: OnboardResponse) => void;
}) {
  const resource = useManagementResource<SystemDetail>(`/systems/${encodeURIComponent(systemId)}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const manifest = resource.data?.versions.find(
    (version) => version.digest === resource.data?.definition.publishedDigest,
  )?.manifest;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!manifest || busy) return;
    const form = new FormData(event.currentTarget);
    try {
      const members = String(form.get('members') ?? '')
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line, index) => {
          const [name = '', phone = '', departmentPath = ''] = line
            .split(',')
            .map((value) => value.trim());
          return { row: index + 2, name, phone, departmentPath };
        });
      const request = {
        ...Object.fromEntries(fields.map(([key]) => [key, String(form.get(key) ?? '').trim()])),
        systemId,
        manifest,
        grantCredits: Number(form.get('grantCredits')),
        members,
        diagnostic: {
          readOnlyCapabilityId: String(form.get('capability')),
          readOnlyInput: JSON.parse(String(form.get('readOnlyInput') || '{}')),
        },
      } as OnboardRequest;
      if (
        !window.confirm(
          `确认向组织 ${request.tenantName}（${request.tenantId}）交付并赠送 ${request.grantCredits} 积分，导入 ${members.length} 名成员？`,
        )
      )
        return;
      setBusy(true);
      setError('');
      onStarted(await kyAppPost<OnboardResponse>('/onboard', request));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '创建交付失败');
    } finally {
      setBusy(false);
    }
  }
  if (!resource.data) return <ResourceState error={resource.error} retry={resource.reload} />;
  if (!manifest || !resource.data.allowedActions?.includes('start_delivery'))
    return <p>当前系统没有可交付的已发布版本。</p>;
  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4 rounded-lg border p-4">
      <div className="grid gap-3 md:grid-cols-2">
        {fields.map(([name, label]) => (
          <label key={name} className="text-sm">
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
      </div>
      <label className="block text-sm">
        赠送积分
        <input
          type="number"
          min="0"
          max="10000000"
          defaultValue="0"
          name="grantCredits"
          required
          disabled={busy}
          className="ml-3 rounded border bg-background p-2"
        />
      </label>
      <label className="block text-sm">
        成员导入（每行：姓名,手机号,部门路径；可留空）
        <textarea
          name="members"
          disabled={busy}
          rows={4}
          className="mt-1 block w-full rounded border bg-background p-2"
        />
      </label>
      <label className="block text-sm">
        验收用只读能力
        <select
          name="capability"
          required
          disabled={busy}
          className="ml-3 rounded border bg-background p-2"
        >
          {manifest.capabilities
            .filter((capability) => capability.riskLevel === 'read_only')
            .map((capability) => (
              <option key={capability.id} value={capability.id}>
                {capability.id}
              </option>
            ))}
        </select>
      </label>
      <label className="block text-sm">
        只读能力验收参数（JSON）
        <textarea
          name="readOnlyInput"
          defaultValue="{}"
          disabled={busy}
          className="mt-1 block w-full rounded border bg-background p-2"
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy}>
        {busy ? '创建交付中…' : '确认并创建交付'}
      </Button>
    </form>
  );
}
