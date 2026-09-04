import { beforeEach, describe, expect, it, vi } from 'vitest';

const { publishOrgAgentArtifacts } = vi.hoisted(() => ({ publishOrgAgentArtifacts: vi.fn() }));
vi.mock('../orgAgentArtifactPublisher.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../orgAgentArtifactPublisher.js')>()),
  publishOrgAgentArtifacts,
}));

import { OrgAgentBackgroundWorkCoordinator } from './orgAgentBackgroundWork.js';
import { deriveOrgAgentTaskWorkspace } from '../orgAgentTaskWorkspace.js';

const manifest = {
  version: 1,
  files: [{ path: '报告.txt', digest: `sha256:${'a'.repeat(64)}`, size: 12 }],
  totalBytes: 12,
  capturedAt: '2026-09-04T00:00:00.000Z',
};

function fixture() {
  const layout = deriveOrgAgentTaskWorkspace({
    agentWorkspaceId: 'ws_tenant-a__agent_agent-a',
    agentRoot: '/agent-root/tenant-a/.agent-agent-a',
    agentMountSubPath: 'tenant-a/.agent-agent-a',
    sharedReadOnlySubPath: 'tenant-a/.agent-agent-a/shared/binding-a/wc-a',
    taskId: 'bg-a',
    attemptNo: 1,
  });
  const work = {
    workOrderId: 'work-a',
    tenantId: 'tenant-a',
    agentId: 'agent-a',
    bindingId: 'binding-a',
    workConversationId: 'wc-a',
    state: 'completed',
    currentAttemptNo: 1,
    version: 3,
  };
  const attempt = {
    workOrderId: 'work-a',
    attemptNo: 1,
    status: 'completed',
    publishState: 'pending',
    runtimeRunId: 'bg-a',
    ...layout,
    artifactManifest: manifest,
  };
  const store = {
    getWorkOrder: vi.fn(async () => work),
    listWorkAttempts: vi.fn(async () => [attempt]),
    getBindingById: vi.fn(async () => ({
      bindingId: 'binding-a',
      agentId: 'agent-a',
      workspaceId: 'ws_tenant-a__agent_agent-a',
    })),
    getWorkConversation: vi.fn(async () => ({
      workConversationId: 'wc-a',
      bindingId: 'binding-a',
    })),
    transitionWorkAttemptPublishState: vi.fn(async (input) => ({
      ...attempt,
      publishState: input.state,
      artifactManifest: input.artifactManifest ?? manifest,
    })),
  };
  return {
    attempt,
    coordinator: new OrgAgentBackgroundWorkCoordinator({
      agentCwd: '/agent-root',
      orgGroupAgentStore: store,
    } as never),
    store,
  };
}

describe('组织 Agent 产物显式发布协调器', () => {
  beforeEach(() => vi.clearAllMocks());

  it('只从当前 attempt artifacts 发布到当前话题的隔离命名空间', async () => {
    const { coordinator, store, attempt } = fixture();
    publishOrgAgentArtifacts.mockResolvedValue({
      ...manifest,
      publishedRoot: `published/work-a/${attempt.attemptId}`,
    });
    await expect(coordinator.publish('tenant-a', 'work-a', 3)).resolves.toMatchObject({
      publishState: 'published',
    });
    expect(publishOrgAgentArtifacts).toHaveBeenCalledWith({
      taskRoot: '/agent-root/tenant-a/.agent-agent-a/work/bg-a/attempt-1/artifacts',
      stagingRoot: '/agent-root/tenant-a/.agent-agent-a/.artifact-publish-staging',
      sharedRoot: '/agent-root/tenant-a/.agent-agent-a/shared/binding-a/wc-a',
      publishedRoot: `published/work-a/${attempt.attemptId}`,
      manifest,
    });
    expect(store.transitionWorkAttemptPublishState).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: attempt.attemptId,
        expectedState: 'pending',
        state: 'published',
      }),
    );
  });

  it('目标内容冲突时持久化 conflict 且不伪报发布成功', async () => {
    publishOrgAgentArtifacts.mockRejectedValue(new Error('ORG_AGENT_ARTIFACT_PUBLISH_CONFLICT'));
    const { coordinator, store, attempt } = fixture();
    await expect(coordinator.publish('tenant-a', 'work-a', 3)).rejects.toThrow(
      'ORG_AGENT_ARTIFACT_PUBLISH_CONFLICT',
    );
    expect(store.transitionWorkAttemptPublishState).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      attemptId: attempt.attemptId,
      expectedState: 'pending',
      state: 'conflict',
    });
  });
});
