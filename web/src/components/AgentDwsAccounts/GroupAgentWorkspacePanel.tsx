import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentDwsAccount } from '@agent/shared';
import { Loader2, RefreshCw } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { authFetch } from '@/lib/authFetch';
import { WorkspaceHierarchy } from './GroupAgentWorkspaceHierarchy';
import {
  GroupAgentApprovalQueue,
  type GroupAgentApproval,
} from './GroupAgentApprovalQueue';

export interface Binding {
  bindingId: string;
  accountId: string;
  agentId: string;
  conversationId: string;
  activationState: 'shadow' | 'active' | 'disabled';
  enabled: boolean;
  revision: number;
  policy: {
    enabled: boolean;
    membership: 'members' | 'members_and_guests';
    guest: 'deny' | 'shared_read_only';
    taskVisibility: 'conversation' | 'requester_only';
    completion: 'reply_to_work_conversation' | 'silent';
    liveDeny: boolean;
  };
  effectiveConfig: {
    identity: { displayName?: string };
    instructions: { system: string };
    knowledge: { contextEnabled: boolean; sourceIds: string[] };
    capabilities: { skillIds: string[]; toolNames: string[]; dwsResourceIds: string[] };
    memory: {
      readAgent: boolean;
      readConversation: boolean;
      adminWriteConversation: boolean;
    };
    access: { triggerRoles: string[]; approvalRoles: string[] };
    speech: { proactive: boolean; requireMention: boolean };
  };
  effectiveConfigComputation?: Record<string, unknown>;
}

export interface WorkOrder {
  workOrderId: string;
  workConversationId: string;
  shortId: string;
  title: string;
  state: string;
  version: number;
  currentAttemptNo: number;
  control: {
    revision: number;
    workerType: 'general' | 'explore';
    supplements: Array<{
      text: string;
      actorOpenId: string;
      createdAt: string;
      kind: 'supplement' | 'review';
    }>;
  };
  updatedAt: string;
  resultEnvelope?: ResultEnvelope;
  attempts: Array<{
    attemptId: string;
    status: string;
    runtimeRunId: string;
    taskWorkspaceId?: string;
    sandboxScopeId?: string;
    mountSubPath?: string;
    sharedReadOnlySubPath?: string;
    publishState: 'pending' | 'published' | 'conflict' | 'rejected';
    resultEnvelope?: ResultEnvelope;
    failure?: string;
    artifactManifest?: {
      version?: number;
      files?: Array<{ path: string; digest: string; size: number }>;
      totalBytes?: number;
      publishedRoot?: string;
    };
  }>;
}
export interface Memory {
  memoryId: string;
  workConversationId?: string;
  memoryScope: string;
  status: string;
  version: number;
  content: Record<string, unknown>;
  policyRevision: number;
}
interface Delivery {
  deliveryId: string;
  deliveryKind: string;
  deliveryState: string;
  content: string;
  updatedAt: string;
  sourceWorkOrderId?: string | null;
  sourceAttemptId?: string | null;
  technicalEvidence: {
    receiptPresent: boolean;
    provider?: Record<string, string | number | boolean>;
    lastErrorCode?: string;
    leaseFence: number;
  };
}
export interface ResultEnvelope {
  status: string;
  summary: string;
  facts: Array<{ key: string; value: string }>;
  artifacts: Array<{ path: string; digest: string; size: number }>;
  writeScope: string[];
}
export interface WorkConversation {
  workConversationId: string;
  rootKey: string;
  rootMessageId?: string;
  sessionId: string;
  state: 'active' | 'closed';
  updatedAt: string;
  workOrders: WorkOrder[];
  memories: Memory[];
}
export interface WorkspaceGroup {
  bindingId: string;
  conversationSpace: { conversationSpaceId: string; conversationId: string };
  workConversations: WorkConversation[];
  memories: Memory[];
}
interface WorkspaceResponse {
  bindings: Binding[];
  workspaces: WorkspaceGroup[];
  deliveries: Delivery[];
  approvals: GroupAgentApproval[];
  observedGroups?: Array<{
    conversationId: string;
    lastEventAt: string;
    bindingId: string | null;
  }>;
}

export type WorkspaceMutation = (
  key: string,
  path: string,
  body: unknown,
  method?: 'POST' | 'PATCH',
) => Promise<void>;

function csv(value: string): string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

export function GroupAgentWorkspacePanel({
  tenantId,
  accounts,
}: {
  tenantId: string;
  accounts: AgentDwsAccount[];
}) {
  const [accountId, setAccountId] = useState('');
  const [data, setData] = useState<WorkspaceResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [groupToCreate, setGroupToCreate] = useState('');
  const eligible = useMemo(
    () => accounts.filter((account) => (
      Boolean(account.profileId && account.corpId && account.dingtalkUserId)
      && account.status !== 'draft'
      && account.status !== 'authorizing'
    )),
    [accounts],
  );
  useEffect(() => {
    if (!eligible.some((account) => account.accountId === accountId))
      setAccountId(eligible[0]?.accountId ?? '');
  }, [accountId, eligible]);

  const load = useCallback(async () => {
    if (!accountId) {
      setData(null);
      return;
    }
    setBusy('load');
    setError('');
    try {
      const response = await authFetch(
        `/api/agent-dws-accounts/${encodeURIComponent(accountId)}/group-workspace?tenantId=${encodeURIComponent(tenantId)}&limit=100`,
      );
      if (!response.ok) throw new Error(await responseError(response));
      setData((await response.json()) as WorkspaceResponse);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '读取群工作台失败');
    } finally {
      setBusy('');
    }
  }, [accountId, tenantId]);
  useEffect(() => {
    setGroupToCreate('');
    void load();
  }, [load]);
  const unboundGroups = useMemo(
    () => (data?.observedGroups ?? []).filter((group) => !group.bindingId),
    [data?.observedGroups],
  );

  const mutate = async (
    key: string,
    path: string,
    body: unknown,
    method: 'POST' | 'PATCH' = 'POST',
  ) => {
    setBusy(key);
    setError('');
    try {
      const response = await authFetch(`${path}?tenantId=${encodeURIComponent(tenantId)}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(await responseError(response));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败');
    } finally {
      setBusy('');
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>组织群 Agent 工作台</CardTitle>
            <CardDescription>
              管理群绑定、后台任务、独立投递与已治理记忆。未激活的群保持旧路由。
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={!accountId || busy === 'load'}
          >
            {busy === 'load' ? <Loader2 className="animate-spin" /> : <RefreshCw />}刷新
          </Button>
        </div>
        <Select value={accountId} onValueChange={setAccountId}>
          <SelectTrigger className="max-w-sm">
            <SelectValue placeholder="选择已授权成员账号" />
          </SelectTrigger>
          <SelectContent>
            {eligible.map((account) => (
              <SelectItem key={account.accountId} value={account.accountId}>
                {account.displayName}{account.status === 'active' ? '' : `（${account.status}）`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent className="space-y-6">
        {error ? (
          <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger-ink"
          >
            {error}
          </div>
        ) : null}
        {!accountId ? (
          <p className="text-sm text-muted-foreground">先完成一个成员账号的 OAuth 授权。</p>
        ) : null}
        {data ? (
          <section className="space-y-3 rounded-lg border p-4">
            <div>
              <h3 className="font-medium">从已观测群创建配置</h3>
              <p className="text-sm text-muted-foreground">
                选择该成员账号 Personal Stream 已收到过 @ 的群，创建独立 shadow 绑定后再配置并激活。
              </p>
            </div>
            {unboundGroups.length ? (
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-72 flex-1 space-y-1">
                  <Label>已观测群</Label>
                  <Select value={groupToCreate} onValueChange={setGroupToCreate}>
                    <SelectTrigger aria-label="已观测群">
                      <SelectValue placeholder="选择一个尚未绑定的群" />
                    </SelectTrigger>
                    <SelectContent>
                      {unboundGroups.map((group) => (
                        <SelectItem key={group.conversationId} value={group.conversationId}>
                          {group.conversationId} · 最近事件 {group.lastEventAt}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  type="button"
                  disabled={!groupToCreate || Boolean(busy)}
                  onClick={() => void mutate(
                    'create-binding',
                    `/api/agent-dws-accounts/${encodeURIComponent(accountId)}/group-workspace/bindings`,
                    { conversationId: groupToCreate },
                  )}
                >
                  创建群配置
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                暂无尚未绑定的已观测群。受钉钉 Personal Stream 能力限制，群需先 @ 一次该成员账号才会进入选择列表。
              </p>
            )}
          </section>
        ) : null}
        {data?.bindings.map((binding) => (
          <BindingEditor
            key={`${binding.bindingId}:${binding.revision}`}
            binding={binding}
            accountId={accountId}
            tenantId={tenantId}
            busy={busy}
            onBusy={setBusy}
            onError={setError}
            onSaved={load}
          />
        ))}
        {data && data.bindings.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            尚未创建群绑定；先从上方已观测群中选择并创建 shadow 绑定。
          </p>
        ) : null}
        <GroupAgentApprovalQueue
          approvals={data?.approvals ?? []}
          busy={busy}
          onDecision={(approval, decision) => {
            void mutate(
              `approval:${approval.approvalId}:${decision}`,
              `/api/agent-dws-accounts/${encodeURIComponent(accountId)}/group-workspace/approvals/${encodeURIComponent(approval.approvalId)}/decision`,
              {
                decision,
                message: decision === 'approved' ? '组织管理员批准执行' : '组织管理员拒绝执行',
              },
            );
          }}
        />
        {data?.workspaces.map((workspace) => (
          <WorkspaceHierarchy
            key={workspace.bindingId}
            workspace={workspace}
            binding={data.bindings.find((item) => item.bindingId === workspace.bindingId)}
            accountId={accountId}
            busy={busy}
            mutate={mutate}
          />
        ))}
        {data?.deliveries.length ? (
          <section className="space-y-2">
            <h3 className="font-medium">投递回执</h3>
            {data.deliveries.map((delivery) => (
              <div
                key={delivery.deliveryId}
                className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm"
              >
                <Badge
                  variant={
                    delivery.deliveryState === 'sent'
                      ? 'success'
                      : delivery.deliveryState === 'unknown'
                        ? 'warning'
                        : 'muted'
                  }
                >
                  {delivery.deliveryState}
                </Badge>
                <span className="min-w-48 flex-1 truncate">{delivery.content}</span>
                <span className="text-xs text-muted-foreground">{delivery.updatedAt}</span>
                {delivery.deliveryState === 'unknown' ? (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void mutate(
                          `sent:${delivery.deliveryId}`,
                          `/api/agent-dws-accounts/${encodeURIComponent(accountId)}/group-workspace/deliveries/${encodeURIComponent(delivery.deliveryId)}/reconcile`,
                          {
                            outcome: 'confirmed_sent',
                            reason: '管理员根据钉钉终态确认已发出',
                            evidence: { source: 'admin' },
                          },
                        )
                      }
                    >
                      确认已发出
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void mutate(
                          `not-sent:${delivery.deliveryId}`,
                          `/api/agent-dws-accounts/${encodeURIComponent(accountId)}/group-workspace/deliveries/${encodeURIComponent(delivery.deliveryId)}/reconcile`,
                          {
                            outcome: 'confirmed_not_sent',
                            reason: '管理员根据钉钉终态确认未发出',
                            evidence: { source: 'admin' },
                          },
                        )
                      }
                    >
                      确认未发出
                    </Button>
                  </>
                ) : null}
              </div>
            ))}
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}

function BindingEditor({
  binding,
  accountId,
  tenantId,
  busy,
  onBusy,
  onError,
  onSaved,
}: {
  binding: Binding;
  accountId: string;
  tenantId: string;
  busy: string;
  onBusy(value: string): void;
  onError(value: string): void;
  onSaved(): Promise<void>;
}) {
  const [enabled, setEnabled] = useState(binding.activationState === 'active' && binding.enabled);
  const [liveDeny, setLiveDeny] = useState(binding.policy.liveDeny);
  const [completion, setCompletion] = useState(binding.policy.completion);
  const [guest, setGuest] = useState(binding.policy.guest);
  const [displayName, setDisplayName] = useState(
    binding.effectiveConfig.identity.displayName ?? '',
  );
  const [instructions, setInstructions] = useState(binding.effectiveConfig.instructions.system);
  const [contextEnabled, setContextEnabled] = useState(
    binding.effectiveConfig.knowledge.contextEnabled,
  );
  const [taskVisibility, setTaskVisibility] = useState(binding.policy.taskVisibility);
  const [triggerRoles, setTriggerRoles] = useState(binding.effectiveConfig.access.triggerRoles);
  const [approvalRoles, setApprovalRoles] = useState(binding.effectiveConfig.access.approvalRoles);
  const [skills, setSkills] = useState(binding.effectiveConfig.capabilities.skillIds.join(', '));
  const [tools, setTools] = useState(binding.effectiveConfig.capabilities.toolNames.join(', '));
  const [dwsResources, setDwsResources] = useState(
    binding.effectiveConfig.capabilities.dwsResourceIds.join(', '),
  );
  const [sources, setSources] = useState(binding.effectiveConfig.knowledge.sourceIds.join(', '));
  const [memoryPolicy, setMemoryPolicy] = useState(binding.effectiveConfig.memory);
  const save = async () => {
    onBusy(`binding:${binding.bindingId}`);
    onError('');
    try {
      const response = await authFetch(
        `/api/agent-dws-accounts/${encodeURIComponent(accountId)}/group-workspace?tenantId=${encodeURIComponent(tenantId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversationId: binding.conversationId,
            expectedRevision: binding.revision,
            enabled,
            policy: {
              ...binding.policy,
              enabled,
              liveDeny,
              completion,
              guest,
              taskVisibility,
              membership: guest === 'shared_read_only' ? 'members_and_guests' : 'members',
            },
            effectiveConfig: {
              ...binding.effectiveConfig,
              identity: { displayName: displayName.trim() || undefined },
              instructions: { system: instructions.trim() },
              knowledge: {
                contextEnabled,
                sourceIds: csv(sources),
              },
              capabilities: {
                skillIds: csv(skills),
                toolNames: csv(tools),
                dwsResourceIds: csv(dwsResources),
              },
              memory: memoryPolicy,
              access: { triggerRoles, approvalRoles },
              // 当前钉钉入口只接收群内 @ 事件；这不是可由界面放开的能力。
              speech: { proactive: false, requireMention: true },
            },
          }),
        },
      );
      if (!response.ok) throw new Error(await responseError(response));
      await onSaved();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : '保存群绑定失败');
    } finally {
      onBusy('');
    }
  };
  return (
    <section className="space-y-4 rounded-xl border p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="font-medium">群 {binding.conversationId}</h3>
        <Badge variant={enabled ? 'success' : 'muted'}>
          {enabled ? '已激活' : binding.activationState}
        </Badge>
        <label className="ml-auto flex items-center gap-2 text-sm">
          <Switch checked={enabled} onCheckedChange={setEnabled} />
          启用
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={liveDeny} onCheckedChange={setLiveDeny} />
          立即阻断
        </label>
      </div>
      <div>
        <Label htmlFor={`instructions-${binding.bindingId}`}>群 Agent 指令</Label>
        <Textarea
          id={`instructions-${binding.bindingId}`}
          value={instructions}
          placeholder="只对当前群生效的职责、边界与输出要求"
          onChange={(event) => setInstructions(event.target.value)}
        />
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <div>
          <Label htmlFor={`display-name-${binding.bindingId}`}>前台显示名</Label>
          <Input
            id={`display-name-${binding.bindingId}`}
            value={displayName}
            placeholder="默认使用账号显示名"
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </div>
        <div>
          <Label>技能 ID</Label>
          <Input value={skills} onChange={(event) => setSkills(event.target.value)} />
        </div>
        <div>
          <Label>工具名</Label>
          <Input value={tools} onChange={(event) => setTools(event.target.value)} />
          <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <Switch
              checked={csv(tools).includes('DwsBusiness')}
              onCheckedChange={(checked) => {
                const next = csv(tools).filter((name) => name !== 'DwsBusiness');
                setTools((checked ? [...next, 'DwsBusiness'] : next).join(', '));
              }}
              aria-label="启用钉钉业务工具"
            />
            启用钉钉业务工具（共享群受动作矩阵约束）
          </label>
        </div>
        <div>
          <Label>知识源 ID</Label>
          <Input value={sources} onChange={(event) => setSources(event.target.value)} />
        </div>
        <div>
          <Label htmlFor={`dws-resources-${binding.bindingId}`}>钉钉资源范围</Label>
          <Input
            id={`dws-resources-${binding.bindingId}`}
            value={dwsResources}
            placeholder="例如 doc:节点ID、drive:文件夹ID"
            onChange={(event) => setDwsResources(event.target.value)}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            启用钉钉业务工具时必填；格式为模块:资源ID，多个用逗号分隔。
          </p>
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={contextEnabled}
            onCheckedChange={setContextEnabled}
            aria-label="启用企业上下文"
          />
          启用企业上下文
        </label>
        <p className="text-xs text-muted-foreground md:col-span-2">
          启用后须配置知识源，并在工具名中保留 ContextSearch 与 ContextGet；服务端会按当前群绑定再次校验。
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {(
          [
            ['readAgent', '读取 Agent 级记忆'],
            ['readConversation', '读取当前话题记忆'],
            ['adminWriteConversation', '允许管理员写入话题记忆'],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex items-center gap-2 text-sm">
            <Switch
              checked={memoryPolicy[key]}
              onCheckedChange={(checked) =>
                setMemoryPolicy((current) => ({ ...current, [key]: checked }))
              }
              aria-label={label}
            />
            {label}
          </label>
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <div>
          <Label>任务可见范围</Label>
          <Select
            value={taskVisibility}
            onValueChange={(value) => setTaskVisibility(value as Binding['policy']['taskVisibility'])}
          >
            <SelectTrigger aria-label="任务可见范围">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="conversation">同一群话题可见</SelectItem>
              <SelectItem value="requester_only">仅发起人可见</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <RoleToggles
          label="可触发角色"
          selected={triggerRoles}
          onChange={setTriggerRoles}
          idPrefix={`trigger-role-${binding.bindingId}`}
        />
        <RoleToggles
          label="可审批/管理角色"
          selected={approvalRoles}
          onChange={setApprovalRoles}
          idPrefix={`approval-role-${binding.bindingId}`}
        />
      </div>
      <div className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">发言触发：</span>
        当前仅支持群内 @ 前台账号触发；必须 @，不支持主动发言。
      </div>
      <div className="flex flex-wrap gap-3">
        <Select
          value={guest}
          onValueChange={(value) => setGuest(value as Binding['policy']['guest'])}
        >
          <SelectTrigger className="w-48" aria-label="游客访问">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="deny">游客拒绝</SelectItem>
            <SelectItem value="shared_read_only">游客只读</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={completion}
          onValueChange={(value) => setCompletion(value as Binding['policy']['completion'])}
        >
          <SelectTrigger className="w-56" aria-label="完成投递">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="reply_to_work_conversation">完成后回复群话题</SelectItem>
            <SelectItem value="silent">完成后静默</SelectItem>
          </SelectContent>
        </Select>
        <Button onClick={() => void save()} disabled={Boolean(busy)}>
          {busy === `binding:${binding.bindingId}` ? <Loader2 className="animate-spin" /> : null}
          保存群配置
        </Button>
      </div>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">查看生效配置与计算过程</summary>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap">
          {JSON.stringify(
            {
              bindingId: binding.bindingId,
              revision: binding.revision,
              policy: binding.policy,
              effectiveConfig: binding.effectiveConfig,
              computation: binding.effectiveConfigComputation,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </section>
  );
}

function RoleToggles({
  label,
  selected,
  onChange,
  idPrefix,
}: {
  label: string;
  selected: string[];
  onChange(value: string[]): void;
  idPrefix: string;
}) {
  const toggle = (role: 'member' | 'org_admin', checked: boolean) => {
    onChange(checked ? [...new Set([...selected, role])] : selected.filter((item) => item !== role));
  };
  return (
    <fieldset className="space-y-1">
      <legend className="text-sm font-medium">{label}</legend>
      {(['member', 'org_admin'] as const).map((role) => (
        <label key={role} className="mr-3 inline-flex items-center gap-2 text-sm">
          <Switch
            checked={selected.includes(role)}
            onCheckedChange={(checked) => toggle(role, checked)}
            aria-label={`${label}：${role}`}
            id={`${idPrefix}-${role}`}
          />
          {role === 'member' ? '成员' : '组织管理员'}
        </label>
      ))}
    </fieldset>
  );
}
