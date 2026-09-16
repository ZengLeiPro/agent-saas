import { useState } from 'react';
import {
  Bot,
  Boxes,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleOff,
  Globe2,
  PackageSearch,
  Plus,
  RotateCcw,
  Search,
} from 'lucide-react';
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
      governanceRoute(routeId, {
        orgId: tenantId,
        search: window.location.search,
        ...(id ? { entityId: id } : {}),
      }),
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
        actions={
          <Button onClick={() => setInstalling((value) => !value)}>
            <Plus className="h-4 w-4" />
            接入业务系统
          </Button>
        }
      />
      {installing && <InstallableSystems tenantId={tenantId} onInstalled={open} />}
      <InstallationList tenantId={tenantId} onOpen={open} onConnect={() => setInstalling(true)} />
    </section>
  );
}

function InstallationList({
  tenantId,
  onOpen,
  onConnect,
}: {
  tenantId: string;
  onOpen: (id: string) => void;
  onConnect: () => void;
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
  const resource = useManagementResource<InstallationPage>(`/installations?${params}`);
  const items = resource.data?.installations ?? [];
  if (!resource.data) return <ResourceState error={resource.error} retry={resource.reload} />;
  return (
    <div className="space-y-4">
      <form
        className="flex flex-wrap gap-2 rounded-xl border bg-card p-3 shadow-sm"
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
          className="h-10 rounded-md border bg-background px-3 text-sm"
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
        <EmptySystems
          filtered={Boolean(appliedQuery) || filter !== 'all'}
          onClear={() => {
            setQuery('');
            setAppliedQuery('');
            setFilter('all');
            setCursor('');
            setCursorHistory([]);
          }}
          onConnect={onConnect}
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {items.map((item) => (
            <InstallationCard key={item.installationId} item={item} onOpen={onOpen} />
          ))}
        </div>
      )}
      {(cursorHistory.length > 0 || resource.data.nextCursor) && (
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
      )}
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
  const StateIcon =
    state === 'ready' ? CircleCheck : state === 'disabled' ? CircleOff : CircleAlert;
  const stateTone =
    state === 'ready'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300'
      : state === 'disabled'
        ? 'border-border bg-muted text-muted-foreground'
        : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300';
  return (
    <article className="group flex min-h-56 flex-col rounded-2xl border bg-card p-5 shadow-sm transition hover:border-brand-300 hover:shadow-md dark:hover:border-brand-800">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-950/40 dark:text-brand-300">
            <Boxes className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h3 className="truncate font-semibold">{item.systemName}</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              最近更新：{formatBusinessSystemTime(item.updatedAt)}
            </p>
          </div>
        </div>
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs ${stateTone}`}
        >
          <StateIcon className="h-3.5 w-3.5" />
          {state === 'ready' ? '可以使用' : state === 'disabled' ? '已停用' : '需要处理'}
        </span>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-2">
        <StatusTile icon={Globe2} label="页面访问" value={businessStatusLabel(page)} />
        <StatusTile icon={Bot} label="Agent 能力" value={businessStatusLabel(agent)} />
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-muted/40 px-3 py-2.5 text-sm">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">下一步</p>
          <p className="mt-0.5 truncate font-medium">{next}</p>
        </div>
      </div>
      <Button
        className="mt-4 w-full justify-between"
        variant="outline"
        onClick={() => onOpen(item.installationId)}
      >
        {state === 'ready' ? '查看系统' : state === 'disabled' ? '查看详情' : '继续接入'}
        <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
      </Button>
    </article>
  );
}

function StatusTile({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Globe2;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border bg-background/70 p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <p className="mt-1.5 text-sm font-medium">{value}</p>
    </div>
  );
}

function EmptySystems({
  filtered,
  onClear,
  onConnect,
}: {
  filtered: boolean;
  onClear: () => void;
  onConnect: () => void;
}) {
  return (
    <div className="flex min-h-80 flex-col items-center justify-center rounded-2xl border border-dashed bg-card/60 px-6 text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-brand-50 text-brand-600 dark:bg-brand-950/40 dark:text-brand-300">
        <PackageSearch className="h-6 w-6" strokeWidth={1.5} />
      </div>
      <h3 className="mt-4 font-semibold">
        {filtered ? '没有找到符合条件的业务系统' : '还没有接入业务系统'}
      </h3>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        {filtered
          ? '可以调整关键词或状态筛选，查看其他业务系统。'
          : '接入后可以统一查看页面、Agent 能力、版本状态和组织授权。'}
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {filtered ? (
          <Button variant="outline" onClick={onClear}>
            <RotateCcw className="h-4 w-4" />
            清除筛选
          </Button>
        ) : null}
        <Button onClick={onConnect}>
          <Plus className="h-4 w-4" />
          接入业务系统
        </Button>
      </div>
    </div>
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
