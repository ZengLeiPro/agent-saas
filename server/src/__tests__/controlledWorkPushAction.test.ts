import { describe, expect, it, vi } from 'vitest';

import { CronToolProvider, cronManageToolDescriptor } from '../agent/cronToolProvider.js';
import { createExecutionAuditRecorder, type AuthorizedToolCall, type ToolCallContext } from '../agent/toolRuntime.js';
import type { TaskboardExecutionContext, TaskboardIntegrationPushService, TaskboardService } from '../taskboard/types.js';

const COMMIT = 'b'.repeat(40);
const OWNER = { id: 'owner-1', username: 'owner', role: 'user' as const, tenantId: 'tenant-1' };

function call(input: unknown): AuthorizedToolCall {
  return {
    toolId: 'CronManage', input,
    authorization: { approved: true, source: 'human_approval', approvalId: 'approval-1' },
  };
}

function context(): ToolCallContext {
  return {
    channelContext: { channel: 'web', sessionOwner: OWNER },
    workspace: {
      id: 'ws_tenant-1__owner-1', root: '/remote/hand/path', executionTarget: 'server-remote',
    },
    runId: 'taskboard-run-1',
    sessionId: 'taskboard-session-1',
    executionAudit: createExecutionAuditRecorder(),
  };
}

function executionContext(overrides: {
  kind?: 'delivery' | 'integration'; purpose?: 'work' | 'review'; ownerUserId?: string;
} = {}): TaskboardExecutionContext {
  const now = '2026-08-21T00:00:00.000Z';
  return {
    identity: {
      tenantId: OWNER.tenantId,
      ownerUserId: overrides.ownerUserId ?? OWNER.id,
      username: OWNER.username,
    },
    task: {
      id: 'task-1', boardId: 'board-1', identifier: 'TASK-1',
      kind: overrides.kind ?? 'integration', workflowVersion: 3,
      title: 'Integration candidate', description: '', status: 'in_progress', priority: 'high',
      labels: [], sortOrder: 1024, commentCount: 0, version: 3, createdAt: now, updatedAt: now,
    },
    boardPrompt: '', comments: [],
    execution: {
      id: 'execution-authoritative', taskId: 'task-1', runId: 'taskboard-run-1',
      sessionId: 'taskboard-session-1', status: 'running', purpose: overrides.purpose ?? 'work',
      requestedBy: OWNER.id, createdAt: now, updatedAt: now,
    },
  };
}

function provider(execution: TaskboardExecutionContext, pushCandidate = vi.fn(async () => ({
  pushed: true as const, candidateId: 'candidate-server', commitOid: COMMIT,
}))) {
  const integrationPush = {
    pushCandidate,
    health: vi.fn(), issue: vi.fn(), push: vi.fn(),
  } as unknown as TaskboardIntegrationPushService;
  const taskboard = {} as TaskboardService;
  return {
    pushCandidate,
    instance: new CronToolProvider({
      service: () => undefined,
      taskboard: {
        service: () => taskboard,
        integrationPush: () => integrationPush,
        resolveTrustedWorkspace: vi.fn(async () => ({
          id: 'ws_tenant-1__owner-1', root: '/srv/shared/workspaces/tenant-1/owner-1',
        })),
        executionStore: () => ({
          getExecutionContextByRunId: vi.fn(async () => execution),
          getExecutionContextBySessionId: vi.fn(async () => execution),
          updateTaskBranchFromExecution: vi.fn(), createTaskFromExecution: vi.fn(), moveTaskFromExecution: vi.fn(),
        }),
      },
    }),
  };
}

describe('execution.integration_candidate.push', () => {
  it('exposes only commitOid, rejects path/ref/execution selectors, and stays dangerous', () => {
    const valid = { target: 'taskboard', action: 'execution.integration_candidate.push', commitOid: COMMIT };
    expect(cronManageToolDescriptor.schema.parse(valid)).toEqual(valid);
    for (const extra of [
      { path: '/tmp/evil' }, { ref: 'refs/heads/main' }, { remote: 'origin' },
      { capabilityToken: 'ipc1.leak' }, { executionId: 'other' }, { candidateId: 'other' },
    ]) expect(() => cronManageToolDescriptor.schema.parse({ ...valid, ...extra })).toThrow();
    expect(cronManageToolDescriptor.resolveCallPolicy?.(valid)).toBeUndefined();
    expect(cronManageToolDescriptor.risk).toBe('dangerous');
  });

  it('derives execution/candidate/workspace server-side and audits without token material', async () => {
    const fixture = provider(executionContext());
    const toolContext = context();
    const result = await fixture.instance.invoke(call({
      target: 'taskboard', action: 'execution.integration_candidate.push', commitOid: COMMIT,
    }), toolContext);
    expect(fixture.pushCandidate).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: OWNER.tenantId, ownerUserId: OWNER.id,
    }), {
      executionId: 'execution-authoritative',
      workspaceRoot: '/srv/shared/workspaces/tenant-1/owner-1',
      commitOid: COMMIT,
    });
    expect(result?.content).toContain('candidate-server');
    expect(result?.content).not.toContain('ipc1.');
    expect(toolContext.executionAudit?.records).toEqual([
      expect.objectContaining({
        operation: 'execution.integration_candidate.push', objectType: 'execution',
        objectId: 'candidate-server', contextKind: 'taskboard_execution',
        resultStatus: 'success', status: 'success',
      }),
    ]);
  });

  it.each([
    ['non-integration task', { kind: 'delivery' as const }],
    ['non-work execution', { purpose: 'review' as const }],
    ['cross-owner execution', { ownerUserId: 'other-owner' }],
  ])('rejects %s before invoking push', async (_name, overrides) => {
    const fixture = provider(executionContext(overrides));
    await expect(fixture.instance.invoke(call({
      target: 'taskboard', action: 'execution.integration_candidate.push', commitOid: COMMIT,
    }), context())).rejects.toThrow();
    expect(fixture.pushCandidate).not.toHaveBeenCalled();
  });

  it('fails closed when the trusted brain-local workspace mapping cannot be proven', async () => {
    const fixture = provider(executionContext());
    const options = (fixture.instance as unknown as { options: { taskboard: { resolveTrustedWorkspace: () => Promise<undefined> } } }).options;
    options.taskboard.resolveTrustedWorkspace = async () => undefined;
    await expect(fixture.instance.invoke(call({
      target: 'taskboard', action: 'execution.integration_candidate.push', commitOid: COMMIT,
    }), context())).rejects.toThrow('缺少受信 workspace 绑定');
    expect(fixture.pushCandidate).not.toHaveBeenCalled();
  });
});
