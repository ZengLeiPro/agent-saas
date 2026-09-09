import { describe, expect, it, vi } from 'vitest';

import {
  PlatformToolRuntime,
  type ToolCallContext,
  type ToolProvider,
} from '../agent/toolRuntime.js';
import { RUNTIME_ISOLATION_POLICY_DIGEST } from './runtimeIsolationEvidence.js';

function workerContext(assertCurrent: (toolName?: string) => Promise<void>): ToolCallContext {
  const workspaceId = 'task-workspace',
    sandboxScopeId = 'task-scope';
  return {
    sessionId: 'task-session',
    runId: 'task-run',
    executionRole: 'worker',
    runtimeIsolationAttested: true,
    workspace: {
      root: '/task',
      id: workspaceId,
      tenantId: 'tenant-1',
      userId: 'agent-1',
      username: 'agent-1',
      executionTarget: 'server-remote',
      sandboxScopeId,
    },
    runtimeIsolationRequirement: {
      tenantId: 'tenant-1',
      taskId: 'work-1',
      runId: 'task-run',
      sessionId: 'task-session',
      workspaceId,
      policyDigest: RUNTIME_ISOLATION_POLICY_DIGEST,
    },
    orgAgentTaskLineage: {
      kind: 'org_agent_task',
      tenantId: 'tenant-1',
      agentId: 'agent-1',
      accountId: 'account-1',
      ownerWorkspaceId: 'agent-workspace',
      bindingId: 'binding-1',
      conversationSpaceId: 'space-1',
      workConversationId: 'conversation-1',
      channelConversationId: 'group-1',
      policyRevision: 1,
      workOrderId: 'work-1',
      taskRunId: 'task-run',
      taskSessionId: 'task-session',
      attemptId: 'attempt-1',
      attemptNo: 1,
      currentAttemptNo: 1,
      taskWorkspaceId: workspaceId,
      sandboxScopeId,
      allowedSourceIds: [],
    },
    orgAgentTaskAuthority: {
      taskRunId: 'task-run',
      taskSessionId: 'task-session',
      attemptId: 'attempt-1',
      assertCurrent,
    },
    channelContext: {
      channel: 'dingtalk',
      sessionOwner: { id: 'agent-1', username: 'agent-1', role: 'user', tenantId: 'tenant-1' },
      orgAgentChannel: {
        accountId: 'account-1',
        agentId: 'agent-1',
        bindingId: 'binding-1',
        conversationSpaceId: 'space-1',
        workConversationId: 'conversation-1',
        policyRevision: 1,
        agentPrincipal: {
          kind: 'org_agent',
          tenantId: 'tenant-1',
          agentId: 'agent-1',
          accountId: 'account-1',
          workspaceId: 'agent-workspace',
        },
        externalActorAssurance: 'mapped',
        allowedToolNames: ['Echo', 'Shell'],
        allowedSkillIds: [],
        allowedSourceIds: [],
        dwsResourceIds: [],
        contextEnabled: false,
        taskVisibility: 'conversation',
        triggerRoles: [],
        approvalRoles: [],
        externalActor: {
          kind: 'external_user',
          provider: 'dingtalk',
          corpId: 'corp-1',
          openId: 'open-1',
          mappedUserId: 'user-1',
          assurance: 'mapped',
          role: 'member',
        },
        channelPrincipal: {
          provider: 'dingtalk',
          accountId: 'account-1',
          conversationId: 'group-1',
          kind: 'group',
        },
      },
    },
  };
}

describe('PlatformToolRuntime org worker live authority', () => {
  it('allows an ordinary background context without org Worker authority', async () => {
    const invoke = vi.fn().mockResolvedValue({ content: 'ok' });
    const runtime = new PlatformToolRuntime({ providers: [{ list: () => [], invoke }] });
    const context = workerContext(vi.fn());
    delete context.executionRole;
    await expect(
      runtime.invoke(
        { toolId: 'Echo', input: {}, authorization: { approved: true, source: 'policy_auto' } },
        context,
      ),
    ).resolves.toEqual({ content: 'ok' });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it.each(['Echo', 'Shell'])(
    'checks live authority before %s provider/transport side effects',
    async (toolId) => {
      const invoke = vi.fn().mockResolvedValue({ content: 'unexpected' });
      const provider = { list: () => [], invoke } satisfies ToolProvider;
      const runtime = new PlatformToolRuntime({ providers: [provider] });
      const assertCurrent = vi
        .fn()
        .mockRejectedValue(new Error('ORG_AGENT_WORKER_TASK_AUTHORITY_REVOKED'));
      await expect(
        runtime.invoke(
          {
            toolId,
            input: toolId === 'Shell' ? { command: 'true' } : {},
            authorization: { approved: true, source: 'policy_auto' },
          },
          workerContext(assertCurrent),
        ),
      ).rejects.toThrow('ORG_AGENT_WORKER_TASK_AUTHORITY_REVOKED');
      expect(assertCurrent).toHaveBeenCalledWith(toolId);
      expect(invoke).not.toHaveBeenCalled();
    },
  );
});
