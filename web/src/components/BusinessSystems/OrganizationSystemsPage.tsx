import { useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsPanelHeader } from '@/components/SettingsCenter/SettingsPanelHeader';
import { governanceRoute } from '@/lib/governanceNavigation';
import { navigateGovernance } from '@/lib/urlSync';
import type {
  InstallationItem,
  InstallationPage,
  SystemDefinition,
} from '@/lib/kyAppManagementApi';
import { useManagementResource, ResourceState } from './ManagementResource';
import { InstallSystemWizard } from './InstallSystemWizard';
import { InstallationDetail } from './InstallationDetail';
import { businessStatusLabel, formatBusinessSystemTime } from './presentation';

const routeId = 'organization.agents.business-systems';
type Filter = 'all' | 'action_required' | 'ready' | 'disabled';

export function OrganizationSystemsPage({
  tenantId,
  installationId,
}: {
  tenantId: string;
  installationId?: string | null;
}) {
  const [installing, setInstalling] = useState(false);
  const open = (id?: string) =>
    navigateGovernance(
      governanceRoute(routeId, { orgId: tenantId, ...(id ? { entityId: id } : {}) }),
    );
  if (installationId)
    return (
      <InstallationDetail
        key={`${tenantId}:${installationId}`}
        tenantId={tenantId}
        installationId={installationId}
        onBack={() => open()}
      />
    );
  return (
    <section className="space-y-4">
      <SettingsPanelHeader
        title="业务系统"
        description="查看页面、Agent 能力和授权状态，并按提示完成接入。"
        actions={(
          <Button onClick={() => setInstalling((value) => !value)}>
            <Plus className="h-4 w-4" />
            接入业务系统
          </Button>
        )}
      />
      {installing && <InstallableSystems tenantId={tenantId} onInstalled={open} />}
      <InstallationList tenantId={tenantId} onOpen={open} />
    </section>
  );
}

function InstallationList({
  tenantId,
  onOpen,
}: {
  tenantId: string;
  onOpen: (id: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [cursor, setCursor] = useState('');
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const params = new URLSearchParams({
    tenantId,
    limit: '50',
    ...(filter === 'all' ? {} : { businessStatus: filter }),
    ...(appliedQuery ? { query: appliedQuery } : {}),
    ...(cursor ? { cursor } : {}),
  });
  const resource = useManagementResource<InstallationPage>(
    `/installations?${params}`,
  );
  const items = resource.data?.installations ?? [];
  if (!resource.data) return <ResourceState error={resource.error} retry={resource.reload} />;
  return (
    <div className="space-y-4">
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setAppliedQuery(query.trim());
          setCursor('');
          setCursorHistory([]);
        }}
      >
        <div className="relative min-w-64 flex-1">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="搜索业务系统"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="pl-8"
            placeholder="搜索业务系统"
          />
        </div>
        <select
          aria-label="状态筛选"
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value as Filter);
            setCursor('');
            setCursorHistory([]);
          }}
          className="rounded border bg-background px-3 text-sm"
        >
          <option value="all">全部</option>
          <option value="action_required">需要处理</option>
          <option value="ready">可以使用</option>
          <option value="disabled">已停用</option>
        </select>
        <Button type="submit" variant="outline">
          搜索
        </Button>
      </form>
      {!items.length ? (
        <p>暂无符合条件的业务系统</p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {items.map((item) => (
            <InstallationCard key={item.installationId} item={item} onOpen={onOpen} />
          ))}
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={cursorHistory.length === 0}
          onClick={() => {
            const history = [...cursorHistory];
            setCursor(history.pop() ?? '');
            setCursorHistory(history);
          }}
        >
          上一页
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!resource.data.nextCursor}
          onClick={() => {
            if (!resource.data?.nextCursor) return;
            setCursorHistory((history) => [...history, cursor]);
            setCursor(resource.data.nextCursor);
          }}
        >
          下一页
        </Button>
      </div>
    </div>
  );
}

function cardState(item: InstallationItem): Exclude<Filter, 'all'> {
  if (item.status === 'disabled' || item.status === 'deleted') return 'disabled';
  return item.status === 'enabled' &&
    item.registeredDigest !== null &&
    item.registeredDigest === item.publishedDigest &&
    item.runtimeStatus === 'healthy'
    ? 'ready'
    : 'action_required';
}

function InstallationCard({
  item,
  onOpen,
}: {
  item: InstallationItem;
  onOpen: (id: string) => void;
}) {
  const state = cardState(item);
  const page =
    state === 'disabled'
      ? 'unavailable'
      : item.status === 'pending' || !item.domainVerifiedAt
        ? 'not_configured'
        : 'available';
  const agent =
    state === 'ready'
      ? 'ready'
      : state === 'disabled'
        ? 'disabled'
        : item.runtimeStatus === 'failed'
          ? 'degraded'
          : 'waiting_service';
  const next =
    state === 'ready'
      ? '已完成接入，可在新对话中使用'
      : state === 'disabled'
        ? '如需恢复，请先启用系统'
        : !item.domainVerifiedAt
          ? '验证业务域名'
          : item.status === 'pending'
            ? '继续完成服务检查、访问授权并启用系统'
          : !item.registeredDigest
            ? '等待业务服务上报并确认版本'
            : '重新检查业务服务';
  return (
    <article className="space-y-3 rounded border p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-medium">{item.systemName}</h3>
          <p className="text-xs text-muted-foreground">
            最近更新：{formatBusinessSystemTime(item.updatedAt)}
          </p>
        </div>
        <span className="rounded bg-muted px-2 py-1 text-xs">
          {state === 'ready' ? '可以使用' : state === 'disabled' ? '已停用' : '需要处理'}
        </span>
      </div>
      <p className="text-sm">
        页面{businessStatusLabel(page)} · Agent 能力{businessStatusLabel(agent)}
      </p>
      <p className="text-sm text-muted-foreground">下一步：{next}</p>
      <Button variant="outline" onClick={() => onOpen(item.installationId)}>
        {state === 'ready' ? '查看系统' : state === 'disabled' ? '查看详情' : '继续接入'}
      </Button>
    </article>
  );
}

function InstallableSystems({
  tenantId,
  onInstalled,
}: {
  tenantId: string;
  onInstalled: (id: string) => void;
}) {
  const resource = useManagementResource<{ systems: SystemDefinition[] }>(
    `/systems/installable?tenantId=${encodeURIComponent(tenantId)}`,
  );
  const [selected, setSelected] = useState('');
  if (!resource.data) return <ResourceState error={resource.error} retry={resource.reload} />;
  return (
    <section className="space-y-3 rounded border p-4">
      <h3 className="font-medium">选择要接入的业务系统</h3>
      {!resource.data.systems.length && <p>暂无已授权且已发布的可接入系统</p>}
      {resource.data.systems.map((system) => (
        <div key={system.systemId} className="flex items-center justify-between rounded border p-3">
          <span>{system.name}</span>
          {system.allowedActions?.includes('install') && (
            <Button variant="outline" onClick={() => setSelected(system.systemId)}>
              选择
            </Button>
          )}
        </div>
      ))}
      {selected && (
        <InstallSystemWizard
          key={`${tenantId}:${selected}`}
          tenantId={tenantId}
          systemId={selected}
          onInstalled={onInstalled}
        />
      )}
    </section>
  );
}
