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
import { authFetch } from '@/lib/authFetch';

interface Binding {
  bindingId: string;
  accountId: string;
  agentId: string;
  conversationId: string;
  activationState: 'shadow' | 'active' | 'disabled';
  enabled: boolean;
  revision: number;
  policy: {
    enabled: boolean;
    membership: 'members';
    guest: 'deny' | 'shared_read_only';
    taskVisibility: 'conversation' | 'requester_only';
    completion: 'reply_to_work_conversation' | 'silent';
    liveDeny: boolean;
  };
  effectiveConfig: {
    identity: { displayName?: string };
    knowledge: { contextEnabled: boolean; sourceIds: string[] };
    capabilities: { skillIds: string[]; toolNames: string[] };
    access: { triggerRoles: string[]; approvalRoles: string[] };
    speech: { proactive: boolean; requireMention: boolean };
  };
  effectiveConfigComputation?: Record<string, unknown>;
}

interface WorkOrder {
  workOrderId: string;
  title: string;
  state: string;
  version: number;
  currentAttemptNo: number;
  updatedAt: string;
  attempts: Array<{
    attemptId: string;
    status: string;
    runtimeRunId: string;
    taskWorkspaceId?: string;
    sandboxScopeId?: string;
    mountSubPath?: string;
    sharedReadOnlySubPath?: string;
  }>;
}
interface Memory {
  memoryId: string;
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
}
interface WorkspaceGroup {
  bindingId: string;
  workOrders: WorkOrder[];
  memories: Memory[];
}
interface WorkspaceResponse {
  bindings: Binding[];
  workspaces: WorkspaceGroup[];
  deliveries: Delivery[];
}

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
  const eligible = useMemo(
    () => accounts.filter((account) => account.status === 'active'),
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
    void load();
  }, [load]);

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
                {account.displayName}
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
            尚未发现群绑定；群内首次 @ 后会生成 shadow 绑定，再由管理员激活。
          </p>
        ) : null}
        {data?.workspaces.map((workspace) => (
          <section key={workspace.bindingId} className="space-y-3">
            <h3 className="font-medium">任务与记忆 · {workspace.bindingId}</h3>
            <div className="space-y-2">
              {workspace.workOrders.map((work) => (
                <div key={work.workOrderId} className="rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant={
                        work.state === 'completed'
                          ? 'success'
                          : work.state === 'failed'
                            ? 'danger'
                            : 'info'
                      }
                    >
                      {work.state}
                    </Badge>
                    <span className="min-w-48 flex-1 font-medium">{work.title}</span>
                    <span className="text-xs text-muted-foreground">
                      尝试 {work.currentAttemptNo}
                    </span>
                    {!['completed', 'failed', 'cancelled'].includes(work.state) ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          void mutate(
                            `cancel:${work.workOrderId}`,
                            `/api/agent-dws-accounts/${encodeURIComponent(accountId)}/group-workspace/work-orders/${encodeURIComponent(work.workOrderId)}/action`,
                            { action: 'cancel', expectedVersion: work.version },
                          )
                        }
                      >
                        取消
                      </Button>
                    ) : null}
                    {['completed', 'failed', 'cancelled'].includes(work.state) ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={Boolean(busy)}
                        onClick={() =>
                          void mutate(
                            `retry:${work.workOrderId}`,
                            `/api/agent-dws-accounts/${encodeURIComponent(accountId)}/group-workspace/work-orders/${encodeURIComponent(work.workOrderId)}/action`,
                            { action: 'retry', expectedVersion: work.version },
                          )
                        }
                      >
                        重试
                      </Button>
                    ) : null}
                  </div>
                  <details className="mt-2 text-xs text-muted-foreground">
                    <summary className="cursor-pointer">查看执行证据</summary>
                    <div className="mt-2 space-y-1 font-mono">
                      <div>WorkOrder {work.workOrderId}</div>
                      {work.attempts.map((attempt, index) => (
                        <div key={attempt.attemptId}>
                          #{index + 1} {attempt.status} · {attempt.attemptId} · run{' '}
                          {attempt.runtimeRunId}
                          {attempt.taskWorkspaceId ? ` · workspace ${attempt.taskWorkspaceId}` : ''}
                          {attempt.sandboxScopeId ? ` · sandbox ${attempt.sandboxScopeId}` : ''}
                        </div>
                      ))}
                    </div>
                  </details>
                </div>
              ))}
            </div>
            <div className="space-y-2">
              {workspace.memories.map((memory) => (
                <div
                  key={memory.memoryId}
                  className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm"
                >
                  <Badge variant={memory.status === 'active' ? 'success' : 'muted'}>
                    {memory.memoryScope} · {memory.status}
                  </Badge>
                  <code className="min-w-48 flex-1 whitespace-pre-wrap text-xs">
                    {JSON.stringify(memory.content)}
                  </code>
                  {memory.status === 'active' && memory.memoryScope !== 'agent' ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void mutate(
                          `promote:${memory.memoryId}`,
                          `/api/agent-dws-accounts/${encodeURIComponent(accountId)}/group-workspace/memories/${encodeURIComponent(memory.memoryId)}/promote`,
                          {
                            reason: '管理员确认提升为 Agent 记忆',
                            policyRevision: memory.policyRevision,
                          },
                        )
                      }
                    >
                      提升
                    </Button>
                  ) : null}
                  {memory.status === 'active' ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void mutate(
                          `revoke:${memory.memoryId}`,
                          `/api/agent-dws-accounts/${encodeURIComponent(accountId)}/group-workspace/memories/${encodeURIComponent(memory.memoryId)}`,
                          { expectedVersion: memory.version, status: 'revoked' },
                          'PATCH',
                        )
                      }
                    >
                      撤销
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
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
  const [skills, setSkills] = useState(binding.effectiveConfig.capabilities.skillIds.join(', '));
  const [tools, setTools] = useState(binding.effectiveConfig.capabilities.toolNames.join(', '));
  const [sources, setSources] = useState(binding.effectiveConfig.knowledge.sourceIds.join(', '));
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
            policy: { ...binding.policy, enabled, liveDeny, completion, guest },
            effectiveConfig: {
              ...binding.effectiveConfig,
              knowledge: {
                contextEnabled: binding.effectiveConfig.knowledge.contextEnabled,
                sourceIds: csv(sources),
              },
              capabilities: { skillIds: csv(skills), toolNames: csv(tools) },
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
      <div className="grid gap-3 md:grid-cols-3">
        <div>
          <Label>技能 ID</Label>
          <Input value={skills} onChange={(event) => setSkills(event.target.value)} />
        </div>
        <div>
          <Label>工具名</Label>
          <Input value={tools} onChange={(event) => setTools(event.target.value)} />
        </div>
        <div>
          <Label>知识源 ID</Label>
          <Input value={sources} onChange={(event) => setSources(event.target.value)} />
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        <Select
          value={guest}
          onValueChange={(value) => setGuest(value as Binding['policy']['guest'])}
        >
          <SelectTrigger className="w-48">
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
          <SelectTrigger className="w-56">
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
