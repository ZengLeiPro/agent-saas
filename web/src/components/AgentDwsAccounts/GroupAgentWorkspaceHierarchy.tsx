import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { WorkOrderControls } from './WorkOrderControls';
import type {
  Binding,
  Memory,
  WorkspaceGroup,
  WorkspaceMutation,
  WorkOrder,
} from './GroupAgentWorkspacePanel';

export function WorkspaceHierarchy({
  workspace,
  binding,
  accountId,
  busy,
  mutate,
}: {
  workspace: WorkspaceGroup;
  binding?: Binding;
  accountId: string;
  busy: string;
  mutate: WorkspaceMutation;
}) {
  return (
    <section className="space-y-3 rounded-xl border p-4">
      <div className="text-sm font-medium">
        ConversationSpace · {workspace.conversationSpace.conversationSpaceId}
      </div>
      {workspace.workConversations.map((conversation) => (
        <div key={conversation.workConversationId} className="space-y-3 border-l pl-4">
          <div className="text-sm">
            <span className="font-medium">WorkConversation</span> ·{' '}
            {conversation.workConversationId}
            <span className="ml-2 text-xs text-muted-foreground">{conversation.state}</span>
          </div>
          {conversation.workOrders.map((work) => (
            <WorkOrderView
              key={work.workOrderId}
              work={work}
              accountId={accountId}
              busy={busy}
              mutate={mutate}
            />
          ))}
          {binding?.effectiveConfig.memory.adminWriteConversation ? (
            <MemoryComposer
              accountId={accountId}
              binding={binding}
              workConversationId={conversation.workConversationId}
              busy={busy}
              mutate={mutate}
            />
          ) : null}
          <MemoryList
            memories={conversation.memories}
            accountId={accountId}
            busy={busy}
            mutate={mutate}
          />
        </div>
      ))}
      <MemoryList memories={workspace.memories} accountId={accountId} busy={busy} mutate={mutate} />
    </section>
  );
}

function WorkOrderView({
  work,
  accountId,
  busy,
  mutate,
}: {
  work: WorkOrder;
  accountId: string;
  busy: string;
  mutate: WorkspaceMutation;
}) {
  const terminal = ['completed', 'failed', 'cancelled'].includes(work.state);
  const pendingPublish =
    work.state === 'completed' && work.attempts.at(-1)?.publishState === 'pending';
  const action = (name: string, extra: Record<string, unknown> = {}) =>
    mutate(
      `${name}:${work.workOrderId}`,
      `/api/agent-dws-accounts/${encodeURIComponent(accountId)}/group-workspace/work-orders/${encodeURIComponent(work.workOrderId)}/action`,
      { action: name, expectedVersion: work.version, ...extra },
    );
  return (
    <div className="rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant={
            work.state === 'completed' ? 'success' : work.state === 'failed' ? 'danger' : 'info'
          }
        >
          {work.state}
        </Badge>
        <span className="min-w-48 flex-1 font-medium">{work.title}</span>
        <span className="text-xs text-muted-foreground">尝试 {work.currentAttemptNo}</span>
        {!terminal ? (
          <Button
            size="sm"
            variant="outline"
            disabled={Boolean(busy)}
            onClick={() => void action('cancel')}
          >
            取消
          </Button>
        ) : null}
        {terminal && !pendingPublish ? (
          <Button
            size="sm"
            variant="outline"
            disabled={Boolean(busy)}
            onClick={() => void action('retry')}
          >
            重试
          </Button>
        ) : null}
        {pendingPublish ? (
          <Button
            size="sm"
            variant="outline"
            disabled={Boolean(busy)}
            onClick={() => void action('publish')}
          >
            发布产物
          </Button>
        ) : null}
      </div>
      <WorkOrderControls
        workOrder={work}
        disabled={Boolean(busy)}
        onAction={(name, extra = {}) => void action(name, extra)}
      />
      <details className="mt-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer">查看执行证据</summary>
        <div className="mt-2 space-y-2">
          <div className="font-mono">
            WorkOrder {work.shortId} · {work.workOrderId}
          </div>
          {work.attempts.map((attempt, index) => (
            <div key={attempt.attemptId} className="rounded border px-2 py-1">
              <div className="font-mono">
                #{index + 1} {attempt.status} · {attempt.attemptId} · run {attempt.runtimeRunId}
                {` · publish ${attempt.publishState}`}
              </div>
              {attempt.resultEnvelope ? (
                <div className="mt-1">
                  <div>{attempt.resultEnvelope.summary}</div>
                  {attempt.resultEnvelope.facts.map((fact) => (
                    <div key={fact.key}>
                      {fact.key}：{fact.value}
                    </div>
                  ))}
                </div>
              ) : null}
              {attempt.failure ? (
                <div className="mt-1 text-danger-ink">{attempt.failure}</div>
              ) : null}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

function MemoryComposer({
  accountId,
  binding,
  workConversationId,
  busy,
  mutate,
}: {
  accountId: string;
  binding: Binding;
  workConversationId: string;
  busy: string;
  mutate: WorkspaceMutation;
}) {
  const [content, setContent] = useState('');
  return (
    <div className="space-y-2 rounded-md border border-dashed p-3">
      <Label htmlFor={`memory-${workConversationId}`}>新增话题记忆</Label>
      <div className="flex gap-2">
        <Input
          id={`memory-${workConversationId}`}
          value={content}
          onChange={(event) => setContent(event.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={Boolean(busy) || !content.trim()}
          onClick={() =>
            void mutate(
              `memory:${workConversationId}`,
              `/api/agent-dws-accounts/${encodeURIComponent(accountId)}/group-workspace/memories`,
              {
                bindingId: binding.bindingId,
                workConversationId,
                memoryScope: 'conversation',
                content: { text: content.trim() },
                provenance: { source: 'admin_workspace' },
                policyRevision: binding.revision,
              },
            )
          }
        >
          保存记忆
        </Button>
      </div>
    </div>
  );
}

function MemoryList({
  memories,
  accountId,
  busy,
  mutate,
}: {
  memories: Memory[];
  accountId: string;
  busy: string;
  mutate: WorkspaceMutation;
}) {
  return (
    <div className="space-y-2">
      {memories.map((memory) => (
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
                  { reason: '管理员确认提升为 Agent 记忆', policyRevision: memory.policyRevision },
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
  );
}
