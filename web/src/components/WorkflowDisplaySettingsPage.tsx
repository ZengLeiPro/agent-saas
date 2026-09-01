import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, CircleAlert, Loader2, RotateCcw, Save, Search } from 'lucide-react';
import type {
  CatalogScenarioPublic,
  WorkflowDisplayPoliciesResponse,
  WorkflowDisplayPolicy,
  WorkflowDisplayScope,
} from '@agent/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { SettingsPanelHeader } from '@/components/SettingsCenter/SettingsPanelHeader';
import { authFetch } from '@/lib/authFetch';
import { cn } from '@/lib/utils';
import { useScenarioLibrary } from '@/components/scenarios/useScenarioLibrary';

interface ScopeSelection {
  scope: WorkflowDisplayScope;
  subjectId: string;
  label: string;
  position?: string;
}

interface Draft {
  displayCount: number;
  workflowIds: string[];
}

function normalizedPosition(value: string | undefined): string {
  return value?.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('zh-CN') ?? '';
}

function responseError(status: number, body: unknown): string {
  const code = typeof body === 'object' && body && 'error' in body ? String(body.error) : '';
  if (status === 409 || code === 'revision_conflict')
    return '配置已被其他管理员更新，请刷新后重试。';
  if (code === 'workflow_not_found') return '已选工作流中包含已失效条目，请重新选择。';
  if (code === 'position_not_found') return '该岗位当前没有有效成员，不能新增岗位覆盖。';
  if (code === 'member_not_found') return '该成员已离开当前组织，请刷新成员列表。';
  return code || `请求失败（${status}）`;
}

function ScopeButton({
  active,
  title,
  meta,
  onClick,
}: {
  active: boolean;
  title: string;
  meta?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors',
        active
          ? 'bg-brand-accent-soft font-medium text-foreground'
          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
      )}
    >
      <span className="truncate">{title}</span>
      {meta && <span className="shrink-0 text-xs">{meta}</span>}
    </button>
  );
}

export default function WorkflowDisplaySettingsPage({ tenantId }: { tenantId: string }) {
  const { workflowLibrary, loading: catalogLoading, error: catalogError } = useScenarioLibrary();
  const [data, setData] = useState<WorkflowDisplayPoliciesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [query, setQuery] = useState('');
  const [workflowQuery, setWorkflowQuery] = useState('');
  const [selection, setSelection] = useState<ScopeSelection>({
    scope: 'tenant',
    subjectId: tenantId,
    label: '组织默认',
  });
  const [draft, setDraft] = useState<Draft | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await authFetch(
        `/api/scenarios/display-policies?tenantId=${encodeURIComponent(tenantId)}`,
      );
      const body = (await response.json()) as WorkflowDisplayPoliciesResponse | { error?: string };
      if (!response.ok) throw new Error(responseError(response.status, body));
      setData(body as WorkflowDisplayPoliciesResponse);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    setSelection({ scope: 'tenant', subjectId: tenantId, label: '组织默认' });
    setDraft(null);
  }, [tenantId]);

  const workflows = workflowLibrary?.scenarios ?? [];
  const workflowById = useMemo(
    () => new Map(workflows.map((item) => [item.id, item])),
    [workflows],
  );
  const policies = data?.policies ?? [];
  const currentPolicy = policies.find(
    (policy) => policy.scope === selection.scope && policy.subjectId === selection.subjectId,
  );

  const inheritedPolicy = useMemo((): WorkflowDisplayPolicy | null => {
    if (selection.scope === 'tenant') return null;
    if (selection.scope === 'position') {
      return (
        policies.find((policy) => policy.scope === 'tenant' && policy.subjectId === tenantId) ??
        null
      );
    }
    const positionId = normalizedPosition(selection.position);
    return (
      policies.find((policy) => policy.scope === 'position' && policy.subjectId === positionId) ??
      policies.find((policy) => policy.scope === 'tenant' && policy.subjectId === tenantId) ??
      null
    );
  }, [policies, selection, tenantId]);

  useEffect(() => {
    setSaved(false);
    setError(null);
    setWorkflowQuery('');
    setDraft(
      currentPolicy
        ? { displayCount: currentPolicy.displayCount, workflowIds: [...currentPolicy.workflowIds] }
        : null,
    );
  }, [currentPolicy?.revision, selection.scope, selection.subjectId]);

  const chooseScope = (next: ScopeSelection) => {
    setSelection(next);
    setQuery('');
  };

  const startOverride = () => {
    const inheritedIds = inheritedPolicy?.workflowIds ?? [];
    const seedIds =
      inheritedIds.length > 0 ? inheritedIds : workflows.slice(0, 3).map((workflow) => workflow.id);
    setDraft({
      displayCount: Math.min(inheritedPolicy?.displayCount ?? 3, seedIds.length),
      workflowIds: seedIds,
    });
  };

  const selectWorkflow = (workflowId: string, checked: boolean) => {
    setDraft((current) => {
      if (!current) return current;
      const workflowIds = checked
        ? [...current.workflowIds, workflowId]
        : current.workflowIds.filter((id) => id !== workflowId);
      return {
        ...current,
        workflowIds,
        displayCount: Math.min(current.displayCount, workflowIds.length),
      };
    });
  };

  const moveWorkflow = (index: number, delta: -1 | 1) => {
    setDraft((current) => {
      if (!current) return current;
      const target = index + delta;
      if (target < 0 || target >= current.workflowIds.length) return current;
      const workflowIds = [...current.workflowIds];
      [workflowIds[index], workflowIds[target]] = [workflowIds[target]!, workflowIds[index]!];
      return { ...current, workflowIds };
    });
  };

  const save = async () => {
    if (!draft || draft.displayCount > draft.workflowIds.length) return;
    setSaving(true);
    setSaved(false);
    try {
      const response = await authFetch('/api/scenarios/display-policies', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId,
          scope: selection.scope,
          subjectId: selection.subjectId,
          subjectLabel: selection.label,
          displayCount: draft.displayCount,
          workflowIds: draft.workflowIds,
          expectedRevision: currentPolicy?.revision ?? 0,
        }),
      });
      const body = (await response.json()) as WorkflowDisplayPolicy | { error?: string };
      if (!response.ok) throw new Error(responseError(response.status, body));
      await load();
      setSaved(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  const restoreInheritance = async () => {
    if (!currentPolicy) {
      setDraft(null);
      return;
    }
    setSaving(true);
    try {
      const params = new URLSearchParams({
        tenantId,
        scope: currentPolicy.scope,
        subjectId: currentPolicy.subjectId,
        expectedRevision: String(currentPolicy.revision),
      });
      const response = await authFetch(`/api/scenarios/display-policies?${params.toString()}`, {
        method: 'DELETE',
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(responseError(response.status, body));
      await load();
      setDraft(null);
      setSaved(true);
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : String(removeError));
    } finally {
      setSaving(false);
    }
  };

  const matchingMembers = (data?.members ?? []).filter((member) => {
    const needle = query.trim().toLocaleLowerCase('zh-CN');
    return (
      !needle ||
      `${member.displayName} ${member.username} ${member.position ?? ''}`
        .toLocaleLowerCase('zh-CN')
        .includes(needle)
    );
  });
  const matchingWorkflows = workflows.filter((workflow) => {
    const needle = workflowQuery.trim().toLocaleLowerCase('zh-CN');
    return (
      !needle || `${workflow.title} ${workflow.id}`.toLocaleLowerCase('zh-CN').includes(needle)
    );
  });
  const inheritedLabel = inheritedPolicy
    ? inheritedPolicy.scope === 'position'
      ? `岗位「${inheritedPolicy.subjectLabel}」`
      : '组织默认'
    : '平台默认推荐';

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <SettingsPanelHeader
        title="工作流"
        description="按组织、岗位和成员配置新建对话底部的工作流推荐；个人覆盖优先于岗位，岗位优先于组织。"
        actions={saved ? <Badge variant="secondary">已保存</Badge> : undefined}
      />
      {error && (
        <div
          role="alert"
          className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
        <Card className="min-h-0 overflow-hidden">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">配置对象</CardTitle>
          </CardHeader>
          <CardContent className="h-[calc(100%-3.5rem)] space-y-3 overflow-y-auto">
            <ScopeButton
              active={selection.scope === 'tenant'}
              title="组织默认"
              meta={policies.some((policy) => policy.scope === 'tenant') ? '已配置' : '平台默认'}
              onClick={() =>
                chooseScope({ scope: 'tenant', subjectId: tenantId, label: '组织默认' })
              }
            />
            <div>
              <div className="mb-1 px-2 text-xs font-medium text-muted-foreground">岗位</div>
              {(data?.positions ?? []).map((position) => (
                <ScopeButton
                  key={position.id}
                  active={selection.scope === 'position' && selection.subjectId === position.id}
                  title={position.label}
                  meta={`${position.memberCount} 人`}
                  onClick={() =>
                    chooseScope({
                      scope: 'position',
                      subjectId: position.id,
                      label: position.label,
                    })
                  }
                />
              ))}
              {!loading && data?.positions.length === 0 && (
                <p className="px-2 py-2 text-xs text-muted-foreground">成员资料中暂无岗位。</p>
              )}
            </div>
            <div>
              <div className="mb-2 px-2 text-xs font-medium text-muted-foreground">成员</div>
              <div className="relative mb-2">
                <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索成员"
                  className="h-8 pl-8 text-xs"
                />
              </div>
              {matchingMembers.map((member) => (
                <ScopeButton
                  key={member.id}
                  active={selection.scope === 'user' && selection.subjectId === member.id}
                  title={member.displayName}
                  meta={member.disabled ? '已停用' : member.position || '未设岗位'}
                  onClick={() =>
                    chooseScope({
                      scope: 'user',
                      subjectId: member.id,
                      label: member.displayName,
                      position: member.position,
                    })
                  }
                />
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="min-h-0 overflow-hidden">
          <CardHeader className="border-b pb-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle className="text-base">{selection.label}</CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  {currentPolicy
                    ? `本层自定义 · 修订版 ${currentPolicy.revision}`
                    : `当前继承：${inheritedLabel}`}
                </p>
              </div>
              <div className="flex gap-2">
                {draft ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={saving}
                      onClick={() => void restoreInheritance()}
                    >
                      <RotateCcw className="size-3.5" />
                      恢复继承
                    </Button>
                    <Button
                      size="sm"
                      disabled={
                        saving || catalogLoading || draft.displayCount > draft.workflowIds.length
                      }
                      onClick={() => void save()}
                    >
                      {saving ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Save className="size-3.5" />
                      )}
                      保存
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    disabled={catalogLoading || !workflowLibrary}
                    onClick={startOverride}
                  >
                    创建本层覆盖
                  </Button>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="h-[calc(100%-5rem)] overflow-y-auto py-4">
            {!draft ? (
              <div className="rounded-xl border border-dashed p-8 text-center">
                <p className="text-sm font-medium">当前未配置本层覆盖</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  成员会自动使用{inheritedLabel}。创建覆盖后，可独立设置数量、内容和顺序。
                </p>
              </div>
            ) : (
              <div className="space-y-5">
                <div className="max-w-xs space-y-1.5">
                  <label htmlFor="workflow-display-count" className="text-sm font-medium">
                    显示数量
                  </label>
                  <Input
                    id="workflow-display-count"
                    type="number"
                    min={0}
                    max={6}
                    value={draft.displayCount}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        displayCount: Math.max(0, Math.min(6, Number(event.target.value) || 0)),
                      })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    支持 0～6 个；设为 0 时隐藏卡片，但保留“查看全部能力”。
                  </p>
                </div>

                <div>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <h3 className="text-sm font-medium">已选工作流与顺序</h3>
                    <Badge variant="outline">已选 {draft.workflowIds.length} 个</Badge>
                  </div>
                  <div className="space-y-2">
                    {draft.workflowIds.map((id, index) => {
                      const workflow = workflowById.get(id);
                      return (
                        <div
                          key={id}
                          className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
                        >
                          <span className="w-5 shrink-0 text-center text-xs text-muted-foreground">
                            {index + 1}
                          </span>
                          <span
                            className={cn(
                              'min-w-0 flex-1 truncate',
                              !workflow && 'text-destructive',
                            )}
                          >
                            {workflow?.title ?? `${id}（已失效）`}
                          </span>
                          {index < draft.displayCount && (
                            <Badge variant="secondary">当前展示</Badge>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            disabled={index === 0}
                            onClick={() => moveWorkflow(index, -1)}
                            aria-label="上移"
                          >
                            <ArrowUp className="size-3.5" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            disabled={index === draft.workflowIds.length - 1}
                            onClick={() => moveWorkflow(index, 1)}
                            aria-label="下移"
                          >
                            <ArrowDown className="size-3.5" />
                          </Button>
                        </div>
                      );
                    })}
                    {draft.workflowIds.length === 0 && (
                      <div className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                        尚未选择工作流。
                      </div>
                    )}
                  </div>
                </div>

                <div>
                  <h3 className="mb-2 text-sm font-medium">选择工作流</h3>
                  <div className="relative mb-3 max-w-md">
                    <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
                    <Input
                      value={workflowQuery}
                      onChange={(event) => setWorkflowQuery(event.target.value)}
                      placeholder="搜索工作流"
                      className="pl-8"
                    />
                  </div>
                  {catalogError && (
                    <div className="flex items-center gap-2 text-sm text-destructive">
                      <CircleAlert className="size-4" />
                      {catalogError}
                    </div>
                  )}
                  <div className="grid gap-2 md:grid-cols-2">
                    {matchingWorkflows.map((workflow: CatalogScenarioPublic) => {
                      const checked = draft.workflowIds.includes(workflow.id);
                      return (
                        <label
                          key={workflow.id}
                          className="flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm hover:bg-muted/40"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(event) => selectWorkflow(workflow.id, event.target.checked)}
                            className="mt-0.5"
                          />
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{workflow.title}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {workflow.id}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
