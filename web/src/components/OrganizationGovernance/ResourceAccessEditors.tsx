import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { governanceAccessApi, governanceResourcesApi } from '@agent/shared/lib/governanceApi';

type EntitlementResourceType =
  'model' | 'agent_template' | 'skill' | 'connector' | 'environment_template';
type AssignmentResourceType =
  'skill' | 'credential' | 'environment_template' | 'connector' | 'dws_delegation';
type AssigneeType = 'everyone' | 'user' | 'directory_group' | 'agent';
type AssignmentEffect = 'allow' | 'deny';

interface ResourceScope {
  resourceType: string;
  mode: 'all' | 'selected';
  resourceIds: string[];
  source: string;
  version: number;
}

interface EntitlementResponse {
  scopes: ResourceScope[];
}
interface ResourceCatalogItem {
  resourceId: string;
  label: string;
  version: number;
}
interface ResourceCatalog {
  resourceType: string;
  items: ResourceCatalogItem[];
}
interface PreviewToken {
  previewId: string;
  baselineDigest: string;
  expiresAt: string;
  impact?: { blockers?: string[] };
}
interface Receipt {
  changeId: string;
  auditId: string;
  effectiveAt?: string;
  projectionStatus?: string;
}

interface AssignmentRule {
  assignmentId?: string;
  assigneeType: AssigneeType;
  assigneeId?: string;
  effect: AssignmentEffect;
  origin?: 'direct' | 'policy_default' | 'migration';
}

interface AssignmentSet {
  version: number;
  assignments: AssignmentRule[];
}
interface MembershipResponse {
  memberships: Array<{
    userId: string;
    status: string;
    directoryProfile?: { displayName?: string; username?: string } | null;
  }>;
}
interface GroupsResponse {
  groups: Array<{ groupId: string; displayName: string; status: string }>;
}

const assigneeLabels: Record<AssigneeType, string> = {
  everyone: '全员',
  user: '成员',
  directory_group: '部门/群组',
  agent: '智能体',
};

function errorText(cause: unknown, fallback: string) {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

function MutationReceipt({ receipt }: { receipt: Receipt | null }) {
  if (!receipt) return null;
  return (
    <div
      role="status"
      className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs"
    >
      已提交 · Change ID：{receipt.changeId} · Audit ID：{receipt.auditId}
      {receipt.projectionStatus ? ` · 投影 ${receipt.projectionStatus}` : ''}
    </div>
  );
}

export function OrganizationEntitlementScopeEditor({
  tenantId,
  resourceType,
  title,
  description,
}: {
  tenantId: string;
  resourceType: EntitlementResourceType;
  title: string;
  description: string;
}) {
  const [scope, setScope] = useState<ResourceScope | null>(null);
  const [catalog, setCatalog] = useState<ResourceCatalogItem[]>([]);
  const [mode, setMode] = useState<'all' | 'selected'>('all');
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<PreviewToken | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [entitlements, resourceCatalog] = await Promise.all([
        governanceAccessApi.getEntitlements<EntitlementResponse>(tenantId),
        governanceResourcesApi.listEntitlementResourceCatalog<ResourceCatalog>(resourceType),
      ]);
      const nextScope =
        entitlements.scopes.find((item) => item.resourceType === resourceType) ?? null;
      setScope(nextScope);
      setCatalog(resourceCatalog.items);
      if (nextScope) {
        setMode(nextScope.mode);
        setSelected(nextScope.resourceIds);
      }
      setError(null);
    } catch (cause) {
      setError(errorText(cause, '读取权威资源范围失败'));
    } finally {
      setLoading(false);
    }
  }, [resourceType, tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const staleIds =
    mode === 'selected'
      ? selected.filter((resourceId) => !catalog.some((item) => item.resourceId === resourceId))
      : [];
  const command = scope
    ? {
        expectedVersion: scope.version,
        mode,
        resourceIds: mode === 'all' ? [] : [...selected].sort(),
      }
    : null;

  const toggle = (resourceId: string) => {
    setSelected((current) =>
      current.includes(resourceId)
        ? current.filter((item) => item !== resourceId)
        : [...current, resourceId],
    );
    setPreview(null);
    setReceipt(null);
  };

  const runPreview = async () => {
    if (!command) return;
    setBusy(true);
    setError(null);
    setReceipt(null);
    try {
      setPreview(
        await governanceAccessApi.previewEntitlementScope<PreviewToken>(
          resourceType,
          command,
          tenantId,
        ),
      );
    } catch (cause) {
      setError(errorText(cause, '范围变更预览失败'));
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!command || !preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await governanceAccessApi.updateEntitlementScope<Receipt>(
        resourceType,
        {
          ...command,
          previewId: preview.previewId,
          baselineDigest: preview.baselineDigest,
          expiresAt: preview.expiresAt,
        },
        tenantId,
      );
      setReceipt(result);
      setPreview(null);
      await load();
    } catch (cause) {
      setError(errorText(cause, '范围变更提交失败'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-medium">{title}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        </div>
        <Badge variant="outline">Entitlement 权威源{scope ? ` · v${scope.version}` : ''}</Badge>
      </div>
      {loading ? <div className="text-sm text-muted-foreground">正在读取权威范围…</div> : null}
      {!loading && !scope ? (
        <div className="text-sm text-destructive">当前组织没有该资源范围基线，已禁止写入。</div>
      ) : null}
      {scope ? (
        <>
          <select
            aria-label={`${title}模式`}
            className="rounded-md border bg-background px-3 py-2 text-sm"
            value={mode}
            onChange={(event) => {
              setMode(event.target.value as 'all' | 'selected');
              setPreview(null);
              setReceipt(null);
            }}
          >
            <option value="all">全部平台资源</option>
            <option value="selected">仅所选资源</option>
          </select>
          {mode === 'selected' ? (
            <div className="grid max-h-64 gap-2 overflow-auto rounded-lg border p-3 md:grid-cols-2">
              {catalog.map((item) => (
                <label key={item.resourceId} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={selected.includes(item.resourceId)}
                    onChange={() => toggle(item.resourceId)}
                  />
                  <span>
                    <span className="block font-medium">{item.label}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {item.resourceId}
                    </span>
                  </span>
                </label>
              ))}
              {!catalog.length ? (
                <div className="text-sm text-muted-foreground">权威目录暂无可选资源。</div>
              ) : null}
            </div>
          ) : null}
          {staleIds.length ? (
            <div role="alert" className="text-xs text-destructive">
              已退出目录的旧资源：{staleIds.join('、')}，请取消后再提交。
            </div>
          ) : null}
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={busy || staleIds.length > 0}
              onClick={() => void runPreview()}
            >
              预览范围变更
            </Button>
            {preview ? (
              <Button
                disabled={
                  busy ||
                  (preview.impact?.blockers?.length ?? 0) > 0 ||
                  Date.parse(preview.expiresAt) <= Date.now()
                }
                onClick={() => void commit()}
              >
                确认提交
              </Button>
            ) : null}
          </div>
          {preview ? (
            <div className="text-xs text-muted-foreground">
              签名预览有效至 {new Date(preview.expiresAt).toLocaleString()}
            </div>
          ) : null}
        </>
      ) : null}
      {error ? (
        <div role="alert" className="text-sm text-destructive">
          {error}
        </div>
      ) : null}
      <MutationReceipt receipt={receipt} />
    </section>
  );
}

function subjectOptions(
  rule: AssignmentRule,
  members: MembershipResponse['memberships'],
  groups: GroupsResponse['groups'],
) {
  if (rule.assigneeType === 'user')
    return members
      .filter((item) => item.status === 'active')
      .map((item) => ({
        id: item.userId,
        label: item.directoryProfile?.displayName ?? item.directoryProfile?.username ?? item.userId,
      }));
  if (rule.assigneeType === 'directory_group')
    return groups
      .filter((item) => item.status === 'active')
      .map((item) => ({ id: item.groupId, label: item.displayName }));
  return [];
}

export function OrganizationResourceAssignmentEditor({
  tenantId,
  resourceType,
  resourceId,
}: {
  tenantId: string;
  resourceType: AssignmentResourceType;
  resourceId: string;
}) {
  const [baseline, setBaseline] = useState<AssignmentSet | null>(null);
  const [rules, setRules] = useState<AssignmentRule[]>([]);
  const [members, setMembers] = useState<MembershipResponse['memberships']>([]);
  const [groups, setGroups] = useState<GroupsResponse['groups']>([]);
  const [preview, setPreview] = useState<PreviewToken | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [assignment, membershipData, groupData] = await Promise.all([
        governanceAccessApi.getAssignment<AssignmentSet>(resourceType, resourceId, tenantId),
        governanceAccessApi.listMemberships<MembershipResponse>(tenantId),
        governanceAccessApi.listDirectoryGroups<GroupsResponse>(tenantId),
      ]);
      setBaseline(assignment);
      setRules(
        assignment.assignments.map(
          ({ assignmentId: _assignmentId, origin: _origin, ...rule }) => rule,
        ),
      );
      setMembers(membershipData.memberships);
      setGroups(groupData.groups);
      setError(null);
    } catch (cause) {
      setError(errorText(cause, '读取资源指派失败'));
    } finally {
      setLoading(false);
    }
  }, [resourceId, resourceType, tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const normalizedRules = useMemo(
    () =>
      rules.map((rule) => ({
        assigneeType: rule.assigneeType,
        ...(rule.assigneeType === 'everyone' ? {} : { assigneeId: rule.assigneeId }),
        effect: rule.effect,
      })),
    [rules],
  );
  const invalid = normalizedRules.some(
    (rule) => rule.assigneeType !== 'everyone' && !rule.assigneeId,
  );
  const command = baseline
    ? { expectedVersion: baseline.version, assignments: normalizedRules }
    : null;

  const patchRule = (index: number, patch: Partial<AssignmentRule>) => {
    setRules((current) =>
      current.map((rule, itemIndex) => (itemIndex === index ? { ...rule, ...patch } : rule)),
    );
    setPreview(null);
    setReceipt(null);
  };
  const addRule = () => {
    setRules((current) => [...current, { assigneeType: 'everyone', effect: 'allow' }]);
    setPreview(null);
    setReceipt(null);
  };
  const removeRule = (index: number) => {
    setRules((current) => current.filter((_, itemIndex) => itemIndex !== index));
    setPreview(null);
    setReceipt(null);
  };

  const runPreview = async () => {
    if (!command || invalid) return;
    setBusy(true);
    setError(null);
    setReceipt(null);
    try {
      setPreview(
        await governanceAccessApi.previewAssignment<PreviewToken>(
          resourceType,
          resourceId,
          command,
          tenantId,
        ),
      );
    } catch (cause) {
      setError(errorText(cause, '资源指派预览失败'));
    } finally {
      setBusy(false);
    }
  };
  const commit = async () => {
    if (!command || !preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await governanceAccessApi.updateAssignment<Receipt>(
        resourceType,
        resourceId,
        {
          ...command,
          previewId: preview.previewId,
          baselineDigest: preview.baselineDigest,
          expiresAt: preview.expiresAt,
        },
        tenantId,
      );
      setReceipt(result);
      setPreview(null);
      await load();
    } catch (cause) {
      setError(errorText(cause, '资源指派提交失败'));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="text-sm text-muted-foreground">正在读取指派规则…</div>;
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-medium">成员、群组与智能体授权</div>
        <Badge variant="outline">Assignment v{baseline?.version ?? 0}</Badge>
      </div>
      {rules.map((rule, index) => {
        const options = subjectOptions(rule, members, groups);
        return (
          <div
            key={`${index}-${rule.assigneeType}`}
            className="grid gap-2 rounded-lg bg-muted/20 p-2 md:grid-cols-[130px_1fr_110px_36px]"
          >
            <select
              aria-label={`规则${index + 1}主体类型`}
              className="rounded-md border bg-background px-2 py-1.5 text-sm"
              value={rule.assigneeType}
              onChange={(event) =>
                patchRule(index, {
                  assigneeType: event.target.value as AssigneeType,
                  assigneeId: undefined,
                })
              }
            >
              {Object.entries(assigneeLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            {rule.assigneeType === 'everyone' ? (
              <div className="px-2 py-1.5 text-sm text-muted-foreground">组织内所有有效成员</div>
            ) : rule.assigneeType === 'agent' ? (
              <input
                aria-label={`规则${index + 1}智能体ID`}
                className="rounded-md border bg-background px-2 py-1.5 text-sm"
                placeholder="组织智能体 ID"
                value={rule.assigneeId ?? ''}
                onChange={(event) => patchRule(index, { assigneeId: event.target.value })}
              />
            ) : (
              <select
                aria-label={`规则${index + 1}主体`}
                className="rounded-md border bg-background px-2 py-1.5 text-sm"
                value={rule.assigneeId ?? ''}
                onChange={(event) =>
                  patchRule(index, { assigneeId: event.target.value || undefined })
                }
              >
                <option value="">请选择</option>
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            )}
            <select
              aria-label={`规则${index + 1}效果`}
              className="rounded-md border bg-background px-2 py-1.5 text-sm"
              value={rule.effect}
              onChange={(event) =>
                patchRule(index, { effect: event.target.value as AssignmentEffect })
              }
            >
              <option value="allow">允许</option>
              <option value="deny">拒绝</option>
            </select>
            <Button
              size="icon"
              variant="ghost"
              aria-label={`删除规则${index + 1}`}
              onClick={() => removeRule(index)}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        );
      })}
      {!rules.length ? (
        <div className="text-sm text-muted-foreground">
          尚未设置直接指派；运行时将按上级范围和默认策略解析。
        </div>
      ) : null}
      <Button size="sm" variant="outline" onClick={addRule}>
        <Plus className="size-4" />
        添加规则
      </Button>
      <div className="flex gap-2">
        <Button
          variant="outline"
          disabled={busy || invalid || !baseline}
          onClick={() => void runPreview()}
        >
          预览指派变更
        </Button>
        {preview ? (
          <Button
            disabled={busy || Date.parse(preview.expiresAt) <= Date.now()}
            onClick={() => void commit()}
          >
            确认提交
          </Button>
        ) : null}
      </div>
      {preview ? (
        <div className="text-xs text-muted-foreground">
          签名预览有效至 {new Date(preview.expiresAt).toLocaleString()}
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="text-sm text-destructive">
          {error}
        </div>
      ) : null}
      <MutationReceipt receipt={receipt} />
    </div>
  );
}

export function OrganizationAssignmentManager({
  tenantId,
  resourceType,
  title,
  items,
}: {
  tenantId: string;
  resourceType: AssignmentResourceType;
  title: string;
  items: Array<{ resourceId: string; label: string }>;
}) {
  const [resourceId, setResourceId] = useState('');
  useEffect(() => {
    setResourceId((current) => (items.some((item) => item.resourceId === current) ? current : ''));
  }, [items]);
  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <div>
        <h3 className="font-medium">{title}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          选择资源后，通过 Assignment 权威链路配置全员、成员、部门/群组或智能体的允许与拒绝规则。
        </p>
      </div>
      <select
        aria-label={`${title}资源`}
        className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        value={resourceId}
        onChange={(event) => setResourceId(event.target.value)}
      >
        <option value="">选择要管理的资源</option>
        {items.map((item) => (
          <option key={item.resourceId} value={item.resourceId}>
            {item.label} · {item.resourceId}
          </option>
        ))}
      </select>
      {resourceId ? (
        <OrganizationResourceAssignmentEditor
          key={`${resourceType}:${resourceId}`}
          tenantId={tenantId}
          resourceType={resourceType}
          resourceId={resourceId}
        />
      ) : null}
      {!items.length ? (
        <div className="text-sm text-muted-foreground">当前没有可指派资源。</div>
      ) : null}
    </section>
  );
}

export function OrganizationCatalogAccessPanel({
  tenantId,
  resourceType,
  scopeTitle,
  assignmentTitle,
}: {
  tenantId: string;
  resourceType: Extract<EntitlementResourceType, 'skill' | 'connector' | 'environment_template'>;
  scopeTitle: string;
  assignmentTitle: string;
}) {
  const [items, setItems] = useState<ResourceCatalogItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    governanceResourcesApi
      .listEntitlementResourceCatalog<ResourceCatalog>(resourceType)
      .then((result) => {
        if (!cancelled) {
          setItems(result.items);
          setError(null);
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(errorText(cause, '读取权威资源目录失败'));
      });
    return () => {
      cancelled = true;
    };
  }, [resourceType]);
  return (
    <div className="space-y-4">
      <OrganizationEntitlementScopeEditor
        tenantId={tenantId}
        resourceType={resourceType}
        title={scopeTitle}
        description="控制平台资源进入本组织的第一层范围；提交后由兼容投影同步旧配置。"
      />
      <OrganizationAssignmentManager
        tenantId={tenantId}
        resourceType={resourceType}
        title={assignmentTitle}
        items={items}
      />
      {error ? (
        <div role="alert" className="text-sm text-destructive">
          {error}
        </div>
      ) : null}
    </div>
  );
}
