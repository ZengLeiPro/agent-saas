import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { kyAppPost, type SystemDefinition } from '@/lib/kyAppManagementApi';
import type { OnboardResponse } from '@/lib/kyAppManagementTypes';
import {
  resolveConnectionAddress,
  type ConnectionOptions,
  type OrganizationConnectionOptions,
} from '@/lib/kyAppConnectionTypes';
import { governanceRoute } from '@/lib/governanceNavigation';
import { navigateGovernance } from '@/lib/urlSync';
import { useManagementResource, ResourceState } from '../BusinessSystems/ManagementResource';

export function CreateDeliveryForm({
  defaultSystemId = '',
  onStarted,
  onOpenExecution,
}: {
  defaultSystemId?: string;
  onStarted: (result: OnboardResponse) => void;
  onOpenExecution?: (id: string) => void;
}) {
  const systems = useManagementResource<{ systems: SystemDefinition[] }>('/systems');
  const [systemId, setSystemId] = useState(defaultSystemId);
  if (!defaultSystemId && !systems.data)
    return <ResourceState error={systems.error} retry={systems.reload} />;
  return (
    <section className="space-y-4">
      <h3 className="font-medium">接入已有组织</h3>
      {!defaultSystemId && (
        <label className="block text-sm">
          业务系统
          <select
            value={systemId}
            onChange={(event) => setSystemId(event.target.value)}
            className="ml-3 rounded border bg-background p-2"
          >
            <option value="">选择业务系统</option>
            {systems.data?.systems
              .filter((system) => system.allowedActions?.includes('start_delivery'))
              .map((system) => (
                <option key={system.systemId} value={system.systemId}>
                  {system.name}
                </option>
              ))}
          </select>
        </label>
      )}
      {systemId && (
        <OrganizationSelection
          key={systemId}
          systemId={systemId}
          onStarted={onStarted}
          onOpenExecution={onOpenExecution}
        />
      )}
    </section>
  );
}

function OrganizationSelection({
  systemId,
  onStarted,
  onOpenExecution,
}: {
  systemId: string;
  onStarted: (result: OnboardResponse) => void;
  onOpenExecution?: (id: string) => void;
}) {
  const resource = useManagementResource<ConnectionOptions>(
    `/systems/${encodeURIComponent(systemId)}/connection-options`,
  );
  const [search, setSearch] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [busy, setBusy] = useState(false);
  if (!resource.data) return <ResourceState error={resource.error} retry={resource.reload} />;
  const options = resource.data;
  const selected = options.organizations.find((item) => item.id === tenantId);
  return (
    <div className="space-y-4 rounded-lg border p-4">
      <p className="text-sm text-muted-foreground">
        选择已有组织及技术联系人，成员和管理员沿用组织现有配置。
      </p>
      <label className="block text-sm">
        选择组织
        <input
          aria-label="搜索组织"
          type="search"
          placeholder="按组织名称搜索"
          value={search}
          disabled={busy}
          onChange={(event) => setSearch(event.target.value)}
          className="my-2 block w-full rounded border bg-background p-2"
        />
        <select
          aria-label="选择组织"
          value={tenantId}
          disabled={busy}
          onChange={(event) => setTenantId(event.target.value)}
          className="block w-full rounded border bg-background p-2"
        >
          <option value="">请选择组织</option>
          {options.organizations
            .filter(
              (item) =>
                item.id === tenantId ||
                `${item.name} ${item.id}`.toLowerCase().includes(search.toLowerCase()),
            )
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
                {item.connection ? '（已接入）' : ''}
              </option>
            ))}
        </select>
      </label>
      {!options.organizations.length && <p>暂无可选择的组织。</p>}
      <Button
        type="button"
        variant="link"
        disabled={busy}
        onClick={() => navigateGovernance(governanceRoute('platform.org-business.tenants'))}
      >
        去创建组织
      </Button>
      {selected?.connection ? (
        <div className="space-y-2">
          <p>该组织已接入此系统，无需重复创建。</p>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              selected.connection?.executionId && onOpenExecution
                ? onOpenExecution(selected.connection.executionId)
                : navigateGovernance(
                    governanceRoute('organization.agents.business-systems', {
                      orgId: tenantId,
                      entityId: selected.connection!.installationId,
                    }),
                  )
            }
          >
            打开已有接入
          </Button>
        </div>
      ) : (
        selected && (
          <ConnectionForm
            key={`${systemId}:${tenantId}`}
            systemId={systemId}
            tenantId={tenantId}
            options={options}
            onStarted={onStarted}
            onBusy={setBusy}
            onRefresh={resource.reload}
          />
        )
      )}
    </div>
  );
}

function ConnectionForm({
  systemId,
  tenantId,
  options,
  onStarted,
  onBusy,
  onRefresh,
}: {
  systemId: string;
  tenantId: string;
  options: ConnectionOptions;
  onStarted: (result: OnboardResponse) => void;
  onBusy: (busy: boolean) => void;
  onRefresh: () => void;
}) {
  const resource = useManagementResource<OrganizationConnectionOptions>(
    `/systems/${encodeURIComponent(systemId)}/connection-options/${encodeURIComponent(tenantId)}`,
  );
  const [contact, setContact] = useState('');
  const [override, setOverride] = useState(!options.settings.baseUrl || !options.settings.origin);
  const [baseUrl, setBaseUrl] = useState(
    resolveConnectionAddress(options.settings.baseUrl, tenantId, systemId),
  );
  const [origin, setOrigin] = useState(
    resolveConnectionAddress(options.settings.origin, tenantId, systemId),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const data = resource.data;
  const contactId = contact || data?.members.find((member) => member.isAdmin)?.userId || '';
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data?.eligible || !contactId || busy || !options.publishedDigest) return;
    if (
      !window.confirm(
        `确认将当前业务系统接入「${data.tenant.name}」，技术联系人为「${data.members.find((member) => member.userId === contactId)?.name}」？接入后仍需配置成员与 Agent 授权。`,
      )
    )
      return;
    setBusy(true);
    onBusy(true);
    setError('');
    try {
      onStarted(
        await kyAppPost<OnboardResponse>('/onboard-existing', {
          systemId,
          tenantId,
          techContactUserId: contactId,
          expectedSettingsVersion: options.version,
          expectedDigest: options.publishedDigest,
          ...(override ? { deployment: { baseUrl: baseUrl.trim(), origin: origin.trim() } } : {}),
        }),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '接入失败');
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }
  if (!data) return <ResourceState error={resource.error} retry={resource.reload} />;
  if (data.installation)
    return (
      <>
        <p>该组织已接入此系统。</p>
        <Button onClick={onRefresh}>刷新接入记录</Button>
      </>
    );
  if (!options.published) return <p>请先发布业务系统版本。</p>;
  if (!data.eligible)
    return (
      <div role="alert">
        <p>组织权益尚未包含此业务系统，请先配置组织权益。</p>
        <Button
          variant="link"
          onClick={() =>
            navigateGovernance(
              governanceRoute('platform.org-business.tenants', {
                entityId: tenantId,
                search: '?tab=resource-scope',
              }),
            )
          }
        >
          配置组织权益
        </Button>
        <Button variant="outline" onClick={resource.reload}>
          重新检查
        </Button>
      </div>
    );
  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4">
      <label className="block text-sm">
        技术联系人
        <select
          aria-label="技术联系人"
          required
          value={contactId}
          disabled={busy}
          onChange={(event) => setContact(event.target.value)}
          className="mt-2 block w-full rounded border bg-background p-2"
        >
          <option value="">请选择组织成员</option>
          {data.members.map((member) => (
            <option key={member.userId} value={member.userId}>
              {member.name}
              {member.isAdmin ? '（组织管理员）' : ''}
            </option>
          ))}
        </select>
      </label>
      {!data.members.length && <p>该组织暂无有效成员，请先在组织成员管理中添加。</p>}
      {options.settings.baseUrl && options.settings.origin && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={override}
            disabled={busy}
            onChange={(event) => setOverride(event.target.checked)}
          />
          为本组织使用独立部署地址
        </label>
      )}
      {override ? (
        <fieldset disabled={busy} className="space-y-3 rounded border p-3">
          <legend className="px-1 text-sm">本组织部署地址</legend>
          <p className="text-xs text-muted-foreground">
            未配置默认地址时，请填写技术联系人提供的地址；也可先到系统“接入配置”维护默认地址。
          </p>
          <label className="block text-sm">
            业务服务地址
            <input
              required
              type="url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              className="mt-1 block w-full rounded border bg-background p-2"
            />
          </label>
          <label className="block text-sm">
            业务页面地址
            <input
              required
              type="url"
              value={origin}
              onChange={(event) => setOrigin(event.target.value)}
              className="mt-1 block w-full rounded border bg-background p-2"
            />
          </label>
        </fieldset>
      ) : (
        <p className="break-all text-sm text-muted-foreground">
          服务地址：{resolveConnectionAddress(options.settings.baseUrl, tenantId, systemId)}
          <br />
          页面地址：{resolveConnectionAddress(options.settings.origin, tenantId, systemId)}
        </p>
      )}
      <p className="text-sm">
        接入组织：{data.tenant.name}；技术联系人：
        {data.members.find((member) => member.userId === contactId)?.name || '未选择'}。
      </p>
      <details className="text-xs text-muted-foreground">
        <summary>查看发布版本</summary>
        <code className="break-all">{options.publishedDigest}</code>
      </details>
      {error && (
        <div role="alert">
          <p>{error}</p>
          <Button type="button" variant="link" onClick={onRefresh}>
            刷新组织与系统配置
          </Button>
        </div>
      )}
      <Button disabled={busy || !contactId}>{busy ? '接入中…' : '确认接入'}</Button>
    </form>
  );
}
