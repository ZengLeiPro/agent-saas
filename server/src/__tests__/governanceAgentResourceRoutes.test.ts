import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerGovernanceAgentResourceRoutes } from '../routes/governanceAgentResourceRoutes.js';

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

function json(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function rig() {
  const resource = {
    agentId: 'org-a', tenantId: 'tenant-a', kind: 'org_agent' as const, ownerUserId: 'admin-1',
    status: 'draft' as const, revision: 1, currentVersionId: undefined,
  };
  const publishedResource = { ...resource, status: 'enabled' as const, revision: 2, currentVersionId: 'agentv-1' };
  const publishVersion = vi.fn().mockResolvedValue({
    resource: publishedResource,
    version: { versionId: 'agentv-1', agentId: 'org-a', digest: 'digest-1', definition },
    created: true,
  });
  const enqueue = vi.fn().mockResolvedValue({ outboxId: 'projection-1' });
  const reconcileOne = vi.fn().mockResolvedValue(null);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { sub: 'admin-1', username: 'admin', tenantId: 'tenant-a', role: 'admin' };
    next();
  });
  const router = express.Router();
  registerGovernanceAgentResourceRoutes({
    router,
    agents: {
      getForTenant: vi.fn().mockResolvedValue(resource),
      getVersion: vi.fn().mockResolvedValue(null),
      publishVersion,
    } as never,
    memberships: {
      getMembership: vi.fn().mockResolvedValue({ tenantId: 'tenant-a', userId: 'admin-1', status: 'active' }),
    } as never,
    changeJobs: { findActiveForTarget: vi.fn().mockResolvedValue(null) } as never,
    previewSecret: 'test-agent-preview-secret-at-least-32-characters',
    personaFor: () => 'org_admin',
    resourceTenantFor: req => req.user?.tenantId ?? null,
    projectionOutbox: { enqueue } as never,
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
  return { baseUrl, publishVersion, enqueue, reconcileOne };
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
      tenantId: 'tenant-a', agentId: 'org-a', expectedRevision: 1, definition,
    }));
    expect(test.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a', projector: 'org_agent',
      payload: { tenantId: 'tenant-a', agentId: 'org-a', versionId: 'agentv-1', resourceRevision: 2 },
    }));
    expect(test.reconcileOne).toHaveBeenCalledOnce();
  });
});
