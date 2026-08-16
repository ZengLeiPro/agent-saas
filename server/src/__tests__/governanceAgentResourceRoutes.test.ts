import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerGovernanceAgentResourceRoutes } from '../routes/governanceAgentResourceRoutes.js';
import { DEFAULT_ORG_AGENT_RUNTIME_POLICY } from '../data/orgAgents/runtimePolicy.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

const definition = {
  schemaVersion: 1 as const,
  name: '开开',
  description: 'AI 实习生',
  starterPrompts: [],
  instructions: '直接协助处理工作，不猜测。',
  skills: [],
  knowledge: [],
  guardrail: {
    mode: 'off' as const,
    enabled: false,
    scopeDescription: '',
    rejectionMessage: '这个问题超出了我的职责范围，暂时无法回答。',
    strictness: 'strict' as const,
  },
  source: 'governance' as const,
};

const dispatcherDefinition = {
  ...definition,
  runtime: {
    ...structuredClone(DEFAULT_ORG_AGENT_RUNTIME_POLICY),
    executionMode: 'dispatcher' as const,
    workerModel: { strategy: 'fixed' as const, modelRef: 'group/worker' },
  },
};

type TestAgentStatus = 'draft' | 'enabled' | 'disabled' | 'archived';
type TestPersona = 'platform_admin' | 'org_admin' | 'member';
interface TestResource {
  agentId: string;
  tenantId: string;
  kind: 'org_agent';
  ownerUserId: string;
  status: TestAgentStatus;
  revision: number;
  currentVersionId?: string;
}

function json(body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function rig(options: {
  status?: TestAgentStatus;
  revision?: number;
  currentVersionId?: string;
  persona?: TestPersona;
  includeProjectionOutbox?: boolean;
  projectionFails?: boolean;
  dispatcherBlockers?: string[];
  currentDefinition?: typeof definition & { runtime?: unknown };
} = {}) {
  let resource: TestResource = {
    agentId: 'org-a', tenantId: 'tenant-a', kind: 'org_agent', ownerUserId: 'admin-1',
    status: options.status ?? 'draft', revision: options.revision ?? 1,
  };
  const configuredVersionId = options.currentVersionId
    ?? (resource.status === 'enabled' || resource.status === 'disabled' ? 'agentv-1' : undefined);
  if (configuredVersionId) resource.currentVersionId = configuredVersionId;
  const currentVersion = {
    versionId: 'agentv-1', agentId: 'org-a', versionNumber: 1,
    digest: 'digest-1', definition: options.currentDefinition ?? definition, publishedAt: '2026-08-13T00:00:00.000Z', publishedBy: 'admin-1',
  };
  const publishedResource: TestResource = {
    ...resource, status: 'enabled', revision: resource.revision + 1, currentVersionId: 'agentv-1',
  };
  const publishVersion = vi.fn().mockImplementation(async () => {
    resource = publishedResource;
    return { resource: publishedResource, version: currentVersion, created: true, changed: true };
  });
  const setStatus = vi.fn().mockImplementation(async (
    tenantId: string,
    agentId: string,
    status: 'enabled' | 'disabled',
    expectedRevision: number,
  ) => {
    if (tenantId !== resource.tenantId || agentId !== resource.agentId || expectedRevision !== resource.revision) {
      throw new Error('AGENT_RESOURCE_VERSION_CONFLICT');
    }
    resource = { ...resource, status, revision: resource.revision + 1 };
    return resource;
  });
  const getForTenant = vi.fn().mockImplementation(async (tenantId: string, agentId: string) => (
    tenantId === resource.tenantId && agentId === resource.agentId ? resource : null
  ));
  const getVersion = vi.fn().mockImplementation(async (versionId: string) => (
    versionId === currentVersion.versionId ? currentVersion : null
  ));
  const enqueue = options.projectionFails
    ? vi.fn().mockRejectedValue(new Error('outbox unavailable'))
    : vi.fn().mockResolvedValue({ outboxId: 'projection-1' });
  const reconcileOne = vi.fn().mockResolvedValue(null);
  const validateDispatcherRuntime = vi.fn().mockResolvedValue(options.dispatcherBlockers ?? []);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { sub: 'admin-1', username: 'admin', tenantId: 'tenant-a', role: 'admin' };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    next();
  });
  const router = express.Router();
  registerGovernanceAgentResourceRoutes({
    router,
    agents: { getForTenant, getVersion, publishVersion, setStatus } as never,
    memberships: {
      getMembership: vi.fn().mockResolvedValue({ tenantId: 'tenant-a', userId: 'admin-1', status: 'active' }),
    } as never,
    changeJobs: { findActiveForTarget: vi.fn().mockResolvedValue(null) } as never,
    validateDispatcherRuntime,
    previewSecret: 'test-agent-preview-secret-at-least-32-characters',
    personaFor: () => options.persona ?? 'org_admin',
    resourceTenantFor: (req, requested) => {
      if (!req.user?.tenantId || (requested && requested !== req.user.tenantId)) return null;
      return req.user.tenantId;
    },
    ...(options.includeProjectionOutbox === false ? {} : { projectionOutbox: { enqueue } as never }),
    projectionReconciler: { reconcileOne } as never,
    now: () => new Date('2026-08-14T00:00:00.000Z'),
  });
  app.use('/api/governance/resources', router);
  const server = await new Promise<Server>(resolve => {
    const next = app.listen(0, '127.0.0.1', () => resolve(next));
  });
  servers.push(server);
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  return {
    baseUrl, publishVersion, setStatus, enqueue, reconcileOne, validateDispatcherRuntime,
    mutateResource: (patch: Partial<TestResource>) => { resource = { ...resource, ...patch }; },
  };
}

describe('governance Agent version publish', () => {
  it('签名绑定 definition，发布成功后持久化 Runtime 兼容投影', async () => {
    const test = await rig();
    const previewResponse = await fetch(
      `${test.baseUrl}/api/governance/resources/agents/org-a/versions/preview`,
      json({ expectedRevision: 1, definition, reason: '创建组织 Agent 开开' }),
    );
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json() as Record<string, unknown>;
    expect(preview).toMatchObject({ canCommit: true, baselineDigest: expect.any(String), expiresAt: expect.any(String) });

    const tampered = await fetch(`${test.baseUrl}/api/governance/resources/agents/org-a/versions`, json({
      expectedRevision: 1,
      definition: { ...definition, name: '被篡改' },
      reason: '创建组织 Agent 开开',
      previewId: preview.previewId,
      baselineDigest: preview.baselineDigest,
      expiresAt: preview.expiresAt,
    }));
    expect(tampered.status).toBe(409);
    await expect(tampered.json()).resolves.toMatchObject({ code: 'AGENT_VERSION_PREVIEW_INVALID' });
    expect(test.publishVersion).not.toHaveBeenCalled();

    const published = await fetch(`${test.baseUrl}/api/governance/resources/agents/org-a/versions`, json({
      expectedRevision: 1,
      definition,
      reason: '创建组织 Agent 开开',
      previewId: preview.previewId,
      baselineDigest: preview.baselineDigest,
      expiresAt: preview.expiresAt,
    }));
    expect(published.status).toBe(200);
    await expect(published.json()).resolves.toMatchObject({
      projectionId: 'projection-1', projectionStatus: 'pending', compatibilityProjection: 'applied_with_projection_pending',
    });
    expect(test.publishVersion).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a', agentId: 'org-a', expectedRevision: 1,
      definition: expect.objectContaining(definition),
    }));
    expect(test.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a', projector: 'org_agent',
      payload: { tenantId: 'tenant-a', agentId: 'org-a', versionId: 'agentv-1', resourceRevision: 2 },
    }));
    expect(test.reconcileOne).toHaveBeenCalledOnce();
  });

  it('dispatcher 缺后台工具或 Worker 模型连接时 preview 与 commit 都 fail-closed', async () => {
    const test = await rig({
      dispatcherBlockers: ['DISPATCHER_REQUIRED_TOOL_MISSING:Agent', 'DISPATCHER_WORKER_MODEL_UNAVAILABLE:background_general'],
    });
    const previewResponse = await fetch(
      `${test.baseUrl}/api/governance/resources/agents/org-a/versions/preview`,
      json({ expectedRevision: 1, definition: dispatcherDefinition, reason: '启用前台调度器模式' }),
    );
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json() as {
      canCommit: boolean;
      previewId: string;
      baselineDigest: string;
      expiresAt: string;
      impact: { blockers: string[] };
    };
    expect(preview.canCommit).toBe(false);
    expect(preview.impact.blockers).toEqual([
      'DISPATCHER_REQUIRED_TOOL_MISSING:Agent',
      'DISPATCHER_WORKER_MODEL_UNAVAILABLE:background_general',
    ]);

    const response = await fetch(`${test.baseUrl}/api/governance/resources/agents/org-a/versions`, json({
      expectedRevision: 1,
      definition: dispatcherDefinition,
      reason: '启用前台调度器模式',
      previewId: preview.previewId,
      baselineDigest: preview.baselineDigest,
      expiresAt: preview.expiresAt,
    }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: 'DISPATCHER_RUNTIME_UNAVAILABLE',
      blockers: expect.arrayContaining(['DISPATCHER_REQUIRED_TOOL_MISSING:Agent']),
    });
    expect(test.publishVersion).not.toHaveBeenCalled();
  });

  it('拒绝引用其他 Agent 的媒体头像路径', async () => {
    const test = await rig();
    const response = await fetch(
      `${test.baseUrl}/api/governance/resources/agents/org-a/versions/preview`,
      json({
        expectedRevision: 1,
        definition: { ...definition, avatar: 'org-agent-avatars/org-b.png' },
        reason: '更新组织 Agent 头像',
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'AGENT_AVATAR_REFERENCE_INVALID' });
    expect(test.publishVersion).not.toHaveBeenCalled();
  });
});

describe('governance Agent status preview and commit', () => {
  const reason = '调整组织 Agent 启停状态';

  it('状态签名被篡改时拒绝 commit，且不写源数据', async () => {
    const test = await rig({ status: 'enabled', revision: 4 });
    const previewResponse = await fetch(
      `${test.baseUrl}/api/governance/resources/agents/org-a/status/preview`,
      json({ expectedRevision: 4, status: 'disabled', reason }),
    );
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json() as Record<string, unknown>;

    const response = await fetch(`${test.baseUrl}/api/governance/resources/agents/org-a/status`, json({
      expectedRevision: 4,
      status: 'enabled',
      reason,
      previewId: preview.previewId,
      baselineDigest: preview.baselineDigest,
      expiresAt: preview.expiresAt,
    }, 'PATCH'));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'AGENT_STATUS_PREVIEW_INVALID' });
    expect(test.setStatus).not.toHaveBeenCalled();
    expect(test.enqueue).not.toHaveBeenCalled();
  });

  it('dispatcher 当前版本依赖失效时禁止重新启用', async () => {
    const test = await rig({
      status: 'disabled',
      revision: 4,
      currentDefinition: dispatcherDefinition,
      dispatcherBlockers: ['DISPATCHER_BACKGROUND_RUNTIME_UNAVAILABLE'],
    });
    const previewResponse = await fetch(
      `${test.baseUrl}/api/governance/resources/agents/org-a/status/preview`,
      json({ expectedRevision: 4, status: 'enabled', reason }),
    );
    const preview = await previewResponse.json() as {
      canCommit: boolean;
      impact: { blockers: string[] };
    };
    expect(preview.canCommit).toBe(false);
    expect(preview.impact.blockers).toContain('DISPATCHER_BACKGROUND_RUNTIME_UNAVAILABLE');
    expect(test.setStatus).not.toHaveBeenCalled();
  });

  it.each([
    { from: 'enabled' as const, to: 'disabled' as const },
    { from: 'disabled' as const, to: 'enabled' as const },
  ])('成功将 Agent 从 $from 切换为 $to，并按更新后 revision 投影', async ({ from, to }) => {
    const test = await rig({ status: from, revision: 4 });
    const previewResponse = await fetch(
      `${test.baseUrl}/api/governance/resources/agents/org-a/status/preview`,
      json({ expectedRevision: 4, status: to, reason }),
    );
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json() as Record<string, unknown>;
    expect(preview).toMatchObject({
      canCommit: true,
      baselineDigest: expect.any(String),
      expiresAt: expect.any(String),
      impact: {
        from: { status: from, versionId: 'agentv-1' },
        to: { status: to, versionId: 'agentv-1' },
        blockers: [],
        reversible: true,
        effectiveMode: 'source_immediate_projection_pending',
      },
    });

    const response = await fetch(`${test.baseUrl}/api/governance/resources/agents/org-a/status`, json({
      expectedRevision: 4,
      status: to,
      reason,
      previewId: preview.previewId,
      baselineDigest: preview.baselineDigest,
      expiresAt: preview.expiresAt,
    }, 'PATCH'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: to,
      revision: 5,
      currentVersionId: 'agentv-1',
      projectionId: 'projection-1',
      projectionStatus: 'pending',
      compatibilityProjection: 'applied_with_projection_pending',
    });
    expect(test.setStatus).toHaveBeenCalledWith('tenant-a', 'org-a', to, 4, 'admin-1');
    expect(test.enqueue).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      projector: 'org_agent',
      idempotencyKey: 'org-a:agentv-1:5',
      payload: { tenantId: 'tenant-a', agentId: 'org-a', versionId: 'agentv-1', resourceRevision: 5 },
    });
    expect(test.reconcileOne).toHaveBeenCalledOnce();
  });

  it('preview 后 revision 变化时拒绝 commit', async () => {
    const test = await rig({ status: 'enabled', revision: 4 });
    const previewResponse = await fetch(
      `${test.baseUrl}/api/governance/resources/agents/org-a/status/preview`,
      json({ expectedRevision: 4, status: 'disabled', reason }),
    );
    const preview = await previewResponse.json() as Record<string, unknown>;
    test.mutateResource({ revision: 5 });

    const response = await fetch(`${test.baseUrl}/api/governance/resources/agents/org-a/status`, json({
      expectedRevision: 4,
      status: 'disabled',
      reason,
      previewId: preview.previewId,
      baselineDigest: preview.baselineDigest,
      expiresAt: preview.expiresAt,
    }, 'PATCH'));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'AGENT_STATUS_PREVIEW_BASELINE_CONFLICT' });
    expect(test.setStatus).not.toHaveBeenCalled();
    expect(test.enqueue).not.toHaveBeenCalled();
  });

  it('源状态已更新但 projection outbox 持久化失败时返回 changed:true', async () => {
    const test = await rig({ status: 'enabled', revision: 4, projectionFails: true });
    const previewResponse = await fetch(
      `${test.baseUrl}/api/governance/resources/agents/org-a/status/preview`,
      json({ expectedRevision: 4, status: 'disabled', reason }),
    );
    const preview = await previewResponse.json() as Record<string, unknown>;

    const response = await fetch(`${test.baseUrl}/api/governance/resources/agents/org-a/status`, json({
      expectedRevision: 4,
      status: 'disabled',
      reason,
      previewId: preview.previewId,
      baselineDigest: preview.baselineDigest,
      expiresAt: preview.expiresAt,
    }, 'PATCH'));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      code: 'GOVERNANCE_PROJECTION_NOT_DURABLE', changed: true,
    });
    expect(test.setStatus).toHaveBeenCalledOnce();
  });

  it('仅组织管理员可管理，显式跨租户目标返回 403', async () => {
    const member = await rig({ status: 'enabled', revision: 4, persona: 'member' });
    const unauthorized = await fetch(
      `${member.baseUrl}/api/governance/resources/agents/org-a/status/preview`,
      json({ expectedRevision: 4, status: 'disabled', reason }),
    );
    expect(unauthorized.status).toBe(404);

    const admin = await rig({ status: 'enabled', revision: 4 });
    const crossTenant = await fetch(
      `${admin.baseUrl}/api/governance/resources/agents/org-a/status/preview?tenantId=tenant-b`,
      json({ expectedRevision: 4, status: 'disabled', reason }),
    );
    expect(crossTenant.status).toBe(403);
  });
});
