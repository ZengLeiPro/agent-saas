import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ServerLocalExecutionProvider, type ToolDescriptor } from '../agent/toolRuntime.js';
import { GROUP_AGENT_FRONTDESK_TOOL_MAX } from '../routes/agentDwsAccounts.js';
import { parseBackgroundTaskMetadata } from './background/backgroundTaskMetadata.js';
import { RUNTIME_ISOLATION_POLICY_DIGEST } from './runtimeIsolationEvidence.js';
import type { RunRecord } from './runStore.js';
import { DefaultToolPolicy } from './toolPolicy.js';
import type { RunContext } from './types.js';

const descriptor = (
  name: string,
  risk: ToolDescriptor['risk'] = 'workspace_write',
): ToolDescriptor => ({
  id: name,
  name,
  displayName: name,
  description: name,
  schema: { parse: (value: unknown) => value } as never,
  risk,
  approvalMode: 'web',
  auditCategory: 'test',
});

function channel(allowedToolNames: string[]) {
  return {
    accountId: 'account-a',
    agentId: 'agent-a',
    bindingId: 'binding-a',
    conversationSpaceId: 'space-a',
    workConversationId: 'workconv-a',
    policyRevision: 3,
    agentPrincipal: {
      kind: 'org_agent' as const,
      tenantId: 'tenant-a',
      agentId: 'agent-a',
      accountId: 'account-a',
      workspaceId: 'workspace-agent-a',
    },
    externalActorAssurance: 'mapped' as const,
    allowedToolNames,
    allowedSkillIds: [],
    allowedSourceIds: [],
    contextEnabled: false,
    taskVisibility: 'conversation' as const,
    actorRole: 'member' as const,
    triggerRoles: ['member' as const],
    approvalRoles: ['member' as const],
    externalActor: {
      kind: 'external_user' as const,
      provider: 'dingtalk' as const,
      corpId: 'corp-a',
      openId: 'open-a',
      assurance: 'mapped' as const,
      mappedUserId: 'user-a',
      role: 'member' as const,
    },
    channelPrincipal: {
      provider: 'dingtalk' as const,
      accountId: 'account-a',
      conversationId: 'group-a',
      kind: 'group' as const,
    },
  };
}

function parsedWorkerMetadata() {
  const allowedToolNames = [...GROUP_AGENT_FRONTDESK_TOOL_MAX];
  const runtimeIsolationRequirement = {
    tenantId: 'tenant-a',
    taskId: 'work-order-a',
    runId: 'background-a',
    sessionId: 'background-session-a',
    workspaceId: 'task-workspace-a',
    policyDigest: RUNTIME_ISOLATION_POLICY_DIGEST,
  };
  const parsed = parseBackgroundTaskMetadata({
    metadata: {
      backgroundTask: true,
      backgroundTaskType: 'agent',
      parentRunId: 'front-run-a',
      parentSessionId: 'front-session-a',
      parentToolCallId: 'call-a',
      description: '生成报告',
      modelRef: 'codex/test',
      cwd: '/task-a',
      workspaceId: 'task-workspace-a',
      parentChannel: 'dingtalk',
      parentOutputTransactionMode: 'terminal_buffered',
      executionRole: 'worker',
      prompt: '生成报告',
      agentType: 'general',
      includeCompanyInfo: false,
      runtimeIsolationRequirement,
      orgAgentChannel: channel(allowedToolNames),
    },
  } as unknown as RunRecord);
  if (!parsed) throw new Error('fixture metadata should parse');
  return { parsed, runtimeIsolationRequirement };
}

function policyContext(input: {
  attested: boolean;
  approvalRoles?: Array<'member' | 'org_admin'>;
}): RunContext {
  const { parsed, runtimeIsolationRequirement } = parsedWorkerMetadata();
  const orgAgentChannel = {
    ...parsed.orgAgentChannel!,
    approvalRoles: input.approvalRoles ?? parsed.orgAgentChannel!.approvalRoles,
  };
  return {
    runId: runtimeIsolationRequirement.runId,
    sessionId: runtimeIsolationRequirement.sessionId,
    model: 'model-a',
    cwd: parsed.cwd,
    workspaceId: runtimeIsolationRequirement.workspaceId,
    sandboxScopeId: 'scope-task-a',
    executionTarget: 'server-remote',
    executionRole: 'worker',
    runtimeIsolationRequirement,
    runtimeIsolationAttested: input.attested,
    approvalPolicy: { autoApproveTools: true, lowRiskOnly: true },
    channelContext: {
      channel: 'dingtalk',
      sessionOwner: { id: 'account-a', username: 'agent-a', role: 'user', tenantId: 'tenant-a' },
      orgAgentChannel,
    },
  };
}

describe('组织群前台与隔离 Worker 工具能力拆分', () => {
  it('前台 ceiling 使用真实 Artifact 名称，且不含任务写工具', () => {
    expect(GROUP_AGENT_FRONTDESK_TOOL_MAX.has('Artifact')).toBe(true);
    expect(GROUP_AGENT_FRONTDESK_TOOL_MAX.has('ArtifactCreate')).toBe(false);
    expect(GROUP_AGENT_FRONTDESK_TOOL_MAX.has('Write')).toBe(false);
    expect(GROUP_AGENT_FRONTDESK_TOOL_MAX.has('Edit')).toBe(false);
    expect(GROUP_AGENT_FRONTDESK_TOOL_MAX.has('Shell')).toBe(false);
  });

  it('从前台 ceiling 固化的后台 metadata 只有在隔离证据通过后才给 Worker 写权限', async () => {
    const live = vi.fn().mockResolvedValue({ allowed: true });
    const policy = new DefaultToolPolicy(live);
    const write = descriptor('Write');

    const frontdesk = policyContext({ attested: false });
    frontdesk.executionRole = undefined;
    expect(await policy.decide(write, {}, frontdesk)).toEqual({
      type: 'deny',
      reason: 'tool is outside the ChannelBinding effective capability',
    });
    expect(await policy.decide(write, {}, policyContext({ attested: false }))).toEqual({
      type: 'deny',
      reason: 'tool is outside the ChannelBinding effective capability',
    });
    expect(await policy.decide(write, {}, policyContext({ attested: true }))).toEqual({
      type: 'allow',
    });
    expect(live).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        bindingId: 'binding-a',
        toolName: 'Write',
      }),
    );
  });

  it('固定增量不放开业务工具，并继续执行角色审批约束', async () => {
    const policy = new DefaultToolPolicy(async () => ({ allowed: true }));
    expect(
      await policy.decide(descriptor('DwsBusiness', 'safe'), {}, policyContext({ attested: true })),
    ).toEqual({ type: 'deny', reason: 'organization Worker cannot use DwsBusiness' });
    expect(
      await policy.decide(
        descriptor('Write'),
        {},
        policyContext({
          attested: true,
          approvalRoles: ['org_admin'],
        }),
      ),
    ).toEqual({ type: 'deny', reason: 'actor role cannot approve this ChannelBinding capability' });
  });

  it.runIf(process.platform === 'linux')(
    '获准 Worker 只能写自己的 task root，不能写 shared root 或其他任务根',
    async () => {
      const base = await mkdtemp(join(tmpdir(), 'org-agent-worker-capability-'));
      const taskRoot = join(base, 'task-a');
      const sharedRoot = join(base, 'agent-shared');
      const otherTaskRoot = join(base, 'task-b');
      await Promise.all([
        mkdir(taskRoot, { recursive: true }),
        mkdir(sharedRoot, { recursive: true }),
        mkdir(otherTaskRoot, { recursive: true }),
      ]);
      const policy = new DefaultToolPolicy(async () => ({ allowed: true }));
      expect(
        await policy.decide(descriptor('Write'), {}, policyContext({ attested: true })),
      ).toEqual({ type: 'allow' });

      const provider = new ServerLocalExecutionProvider();
      const workspace = {
        root: taskRoot,
        sharedReadOnlyRoot: sharedRoot,
        executionTarget: 'server-remote' as const,
      };
      await expect(
        provider.execute({
          toolName: 'Write',
          input: { path: 'result.txt', content: 'ok' },
          context: { workspace },
        }),
      ).resolves.toMatchObject({ status: 'success' });
      await expect(
        provider.execute({
          toolName: 'Write',
          input: { path: join(sharedRoot, 'forbidden.txt'), content: 'x' },
          context: { workspace },
        }),
      ).resolves.toMatchObject({
        status: 'error',
        error: expect.stringContaining('outside workspace'),
      });
      await expect(
        provider.execute({
          toolName: 'Write',
          input: { path: join(otherTaskRoot, 'forbidden.txt'), content: 'x' },
          context: { workspace },
        }),
      ).resolves.toMatchObject({
        status: 'error',
        error: expect.stringContaining('outside workspace'),
      });
    },
  );
});
