import { describe, expect, it } from 'vitest';

import { deriveOrgAgentTaskWorkspace } from './orgAgentTaskWorkspace.js';

describe('deriveOrgAgentTaskWorkspace', () => {
  it('为每次 Worker 尝试派生独立可写根并保留 Agent 根只读引用', () => {
    const first = deriveOrgAgentTaskWorkspace({
      agentWorkspaceId: 'ws_tenant-a__agent_agent-a',
      agentRoot: '/nas/workspaces/tenant-a/.agent-agent-a',
      agentMountSubPath: 'workspaces/tenant-a/.agent-agent-a',
      sharedReadOnlySubPath: 'workspaces/tenant-a/.agent-agent-a/shared/binding-a/work-a',
      taskId: 'bg-task-a',
      attemptNo: 1,
    });
    const second = deriveOrgAgentTaskWorkspace({
      agentWorkspaceId: 'ws_tenant-a__agent_agent-a',
      agentRoot: '/nas/workspaces/tenant-a/.agent-agent-a',
      agentMountSubPath: 'workspaces/tenant-a/.agent-agent-a',
      sharedReadOnlySubPath: 'workspaces/tenant-a/.agent-agent-a/shared/binding-a/work-a',
      taskId: 'bg-task-a',
      attemptNo: 2,
    });

    expect(first.taskRoot).toBe('/nas/workspaces/tenant-a/.agent-agent-a/work/bg-task-a/attempt-1');
    expect(first.mountSubPath).toBe('workspaces/tenant-a/.agent-agent-a/work/bg-task-a/attempt-1');
    expect(first.sharedReadOnlySubPath).toBe('workspaces/tenant-a/.agent-agent-a/shared/binding-a/work-a');
    expect(first.sandboxScopeId).not.toBe(second.sandboxScopeId);
    expect(first.attemptId).not.toBe(second.attemptId);
  });

  it('拒绝可逃逸任务路径与非法 attempt', () => {
    expect(() =>
      deriveOrgAgentTaskWorkspace({
        agentWorkspaceId: 'ws-a',
        agentRoot: '/workspace',
        agentMountSubPath: 'workspaces/a',
        sharedReadOnlySubPath: 'workspaces/a/shared/binding-a/work-a',
        taskId: '../escape',
        attemptNo: 1,
      }),
    ).toThrow();
    expect(() =>
      deriveOrgAgentTaskWorkspace({
        agentWorkspaceId: 'ws-a',
        agentRoot: '/workspace',
        agentMountSubPath: 'workspaces/a',
        sharedReadOnlySubPath: 'workspaces/a/shared/binding-a/work-a',
        taskId: 'task-a',
        attemptNo: 0,
      }),
    ).toThrow();
  });
});
