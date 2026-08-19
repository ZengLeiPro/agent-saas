import { describe, expect, it, vi } from 'vitest';

import { appendResolvedRunSnapshot, ensureRuntimeHandRegistered } from '../runtime/rawRuntimeRunDispatch.js';
import { RUNTIME_ISOLATION_POLICY_DIGEST } from '../runtime/runtimeIsolationEvidence.js';

function input(result: Record<string, unknown>, append = vi.fn().mockResolvedValue(undefined)) {
  const warn = vi.fn();
  return {
    value: {
      config: {
        runPreflightService: { preflight: vi.fn().mockResolvedValue(result) },
        runResolutionSnapshotStore: { append },
        logger: { warn },
      },
      runId: 'run-1',
      session: { sessionId: 'session-1', userId: 'user-1', tenantId: 'tenant-a' },
      executionTarget: 'server',
      hands: [],
    } as never,
    append,
    warn,
  };
}

const NOW = '2026-08-08T00:00:00.000Z';
const snapshot = { snapshotId: 'snapshot-1', runId: 'run-1' };
const accessDecision = { reasonCode: 'ASSIGNMENT_REQUIRED' };

describe('Raw Runtime governance snapshot fail-closed', () => {
  it('环境 provision 失败注册 unhealthy 并阻断，不得伪装 ready', async () => {
    const registered: Record<string, unknown>[] = [];
    const events: Record<string, unknown>[] = [];
    const transport = {
      listInternalTools: () => [],
      provision: vi.fn().mockResolvedValue({ status: 'error', error: 'image unavailable' }),
    };
    await expect(ensureRuntimeHandRegistered({
      handStore: {
        register: vi.fn().mockImplementation(async record => {
          registered.push(record);
          return { ...record, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        }),
      } as never,
      eventStore: { append: vi.fn().mockImplementation(async event => { events.push(event); }) } as never,
      executionTransportRegistry: { has: () => true, get: () => transport } as never,
      executionTarget: 'server-local', sessionId: 'session-1', runId: 'run-1', workspaceId: 'workspace-1',
    })).rejects.toThrow('HAND_PROVISION_FAILED:image unavailable');
    expect(registered[0]).toMatchObject({ status: 'unhealthy' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'hand_failure', classifiedAs: 'unhealthy' }));
  });

  it('Environment Template 必须先通过 Assignment，且使用发布版本 recipe/digest provision', async () => {
    const registered: Record<string, unknown>[] = [];
    const provision = vi.fn().mockResolvedValue({ status: 'ok' });
    const authorizeEnvironmentTemplate = vi.fn().mockResolvedValue(true);
    const environmentVersion = {
      versionId: 'env-v1', templateId: 'template-1', versionNumber: 1,
      recipe: {
        packages: ['ripgrep'], envKeys: ['LANG'], setupCommands: ['echo ready'],
        resources: { cpu: '1', memoryMb: 512 },
      },
      digest: 'recipe-digest-v1', publishedAt: '2026-08-08T00:00:00.000Z', publishedBy: 'admin-1',
    };
    await ensureRuntimeHandRegistered({
      handStore: {
        register: vi.fn().mockImplementation(async record => {
          registered.push(record);
          return { ...record, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        }),
      } as never,
      eventStore: { append: vi.fn() } as never,
      executionTransportRegistry: {
        has: () => true,
        get: () => ({ listInternalTools: () => [], provision }),
      } as never,
      executionTarget: 'server-local', sessionId: 'session-1', runId: 'run-1', workspaceId: 'workspace-1',
      userId: 'user-1', userTenantId: 'tenant-a', agentId: 'agent-1',
      environmentTemplateVersionId: 'env-v1', authorizeEnvironmentTemplate,
      environmentStore: {
        getTemplateVersion: vi.fn().mockResolvedValue(environmentVersion),
        getProvider: vi.fn().mockResolvedValue({ providerId: 'server-local', status: 'enabled' }),
        getTemplate: vi.fn().mockResolvedValue({ templateId: 'template-1', status: 'published' }),
        getInstance: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ instanceId: 'session-1:server-local', revision: 1 }),
        transition: vi.fn().mockResolvedValue(undefined),
      } as never,
    });
    expect(authorizeEnvironmentTemplate).toHaveBeenCalledWith({
      tenantId: 'tenant-a', userId: 'user-1', agentId: 'agent-1', templateId: 'template-1',
    });
    expect(provision).toHaveBeenCalledWith(expect.objectContaining({
      packages: ['ripgrep'], envKeys: ['LANG'], setupCommands: ['echo ready'],
      resources: { cpu: '1', memoryMb: 512 },
    }));
    expect(registered[0]).toMatchObject({
      templateVersionId: 'env-v1', recipeDigest: 'recipe-digest-v1',
    });
  });

  it('resume 未显式携带 Template Version 时复用现有 Instance 的 immutable version', async () => {
    const provision = vi.fn().mockResolvedValue({ status: 'ok' });
    await ensureRuntimeHandRegistered({
      handStore: { register: vi.fn().mockImplementation(async record => record) } as never,
      eventStore: { append: vi.fn() } as never,
      executionTransportRegistry: {
        has: () => true,
        get: () => ({ listInternalTools: () => [], provision }),
      } as never,
      executionTarget: 'server-local', sessionId: 'session-1', workspaceId: 'workspace-1',
      userId: 'user-1', userTenantId: 'tenant-a', authorizeEnvironmentTemplate: vi.fn().mockResolvedValue(true),
      environmentStore: {
        getInstance: vi.fn().mockResolvedValue({
          instanceId: 'session-1:server-local', templateId: 'template-1', templateVersionId: 'env-v1',
          providerId: 'server-local', status: 'ready', revision: 2,
        }),
        getTemplateVersion: vi.fn().mockResolvedValue({
          versionId: 'env-v1', templateId: 'template-1', versionNumber: 1,
          recipe: { packages: ['jq'], envKeys: [], setupCommands: ['echo resume'], resources: {} },
          digest: 'digest-v1', publishedAt: NOW, publishedBy: 'admin-1',
        }),
        getProvider: vi.fn().mockResolvedValue({ providerId: 'server-local', status: 'enabled' }),
        getTemplate: vi.fn().mockResolvedValue({ templateId: 'template-1', status: 'published' }),
        upsert: vi.fn().mockResolvedValue(undefined),
      } as never,
    });
    expect(provision).toHaveBeenCalledWith(expect.objectContaining({
      packages: ['jq'], setupCommands: ['echo resume'],
    }));
  });

  it('Environment Template 未获 Assignment 时在 provision 前 fail closed', async () => {
    const provision = vi.fn();
    await expect(ensureRuntimeHandRegistered({
      handStore: { register: vi.fn() } as never,
      eventStore: { append: vi.fn() } as never,
      executionTransportRegistry: {
        has: () => true,
        get: () => ({ listInternalTools: () => [], provision }),
      } as never,
      executionTarget: 'server-local', sessionId: 'session-1', workspaceId: 'workspace-1',
      userId: 'user-1', userTenantId: 'tenant-a', environmentTemplateVersionId: 'env-v1',
      authorizeEnvironmentTemplate: vi.fn().mockResolvedValue(false),
      environmentStore: {
        getInstance: vi.fn().mockResolvedValue(null),
        getProvider: vi.fn().mockResolvedValue({ providerId: 'server-local', status: 'enabled' }),
        getTemplate: vi.fn().mockResolvedValue({ templateId: 'template-1', status: 'published' }),
        getTemplateVersion: vi.fn().mockResolvedValue({
          versionId: 'env-v1', templateId: 'template-1', versionNumber: 1,
          recipe: { packages: [], envKeys: [], setupCommands: [], resources: {} },
          digest: 'digest-v1', publishedAt: NOW, publishedBy: 'admin-1',
        }),
      } as never,
    })).rejects.toThrow('ENVIRONMENT_TEMPLATE_ASSIGNMENT_REQUIRED');
    expect(provision).not.toHaveBeenCalled();
  });

  it('accepts fresh evidence only when it is bound to the exact provisioned recipe/run/sandbox scope', async () => {
    const requirement = {
      tenantId: 'tenant-a', taskId: 'task-1', runId: 'run-1', sessionId: 'session-1',
      workspaceId: 'workspace-1', policyDigest: RUNTIME_ISOLATION_POLICY_DIGEST,
    };
    const now = Date.now();
    const provision = vi.fn().mockResolvedValue({
      status: 'ok',
      metadata: { metadata: { runtimeIsolationEvidence: {
        ...requirement,
        sandboxName: 'as-session-1', sandboxScopeId: 'workspace-1',
        issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 30_000).toISOString(),
      } } },
    });
    const register = vi.fn().mockImplementation(async record => record);
    const resolveForRegister = vi.fn();
    await expect(ensureRuntimeHandRegistered({
      handStore: { register } as never,
      eventStore: { append: vi.fn() } as never,
      executionTransportRegistry: { has: () => true, get: () => ({ listInternalTools: () => [], provision }) } as never,
      executionTarget: 'server-remote', sessionId: 'session-1', runId: 'run-1', workspaceId: 'workspace-1',
      runtimeIsolationRequirement: requirement,
      tenantRemoteHands: [{ id: 'tenant-ecs', baseUrl: 'http://tenant-ecs-hand:3300', invokeTimeoutMs: 60_000 }],
      tenantRemoteHandResolver: { resolveForRegister } as never,
    })).resolves.toBeUndefined();
    expect(provision).toHaveBeenCalledWith(expect.objectContaining({ runtimeIsolationRequirement: requirement }));
    expect(resolveForRegister).not.toHaveBeenCalled();
    expect(register).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['missing', undefined],
    ['wrong task', { taskId: 'task-other' }],
    ['wrong scope', { sandboxScopeId: 'scope-other' }],
    ['expired', { issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:00:01.000Z' }],
  ])('fails closed before Agent loop for %s actual-sandbox evidence', async (_case, mutation) => {
    const requirement = {
      tenantId: 'tenant-a', taskId: 'task-1', runId: 'run-1', sessionId: 'session-1',
      workspaceId: 'workspace-1', policyDigest: RUNTIME_ISOLATION_POLICY_DIGEST,
    };
    const now = Date.now();
    const baseEvidence = {
      ...requirement, sandboxName: 'as-session-1', sandboxScopeId: 'workspace-1',
      issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 30_000).toISOString(),
    };
    const evidence = mutation === undefined ? undefined : { ...baseEvidence, ...mutation };
    await expect(ensureRuntimeHandRegistered({
      handStore: { register: vi.fn().mockImplementation(async record => record) } as never,
      eventStore: { append: vi.fn() } as never,
      executionTransportRegistry: {
        has: () => true,
        get: () => ({ listInternalTools: () => [], provision: vi.fn().mockResolvedValue({ status: 'ok', metadata: { metadata: { runtimeIsolationEvidence: evidence } } }) }),
      } as never,
      executionTarget: 'server-remote', sessionId: 'session-1', runId: 'run-1', workspaceId: 'workspace-1',
      runtimeIsolationRequirement: requirement,
    })).rejects.toThrow(/RUNTIME_ISOLATION_EVIDENCE_/);
  });

  it('shadow 模式 Snapshot 持久化失败只告警，不阻断运行', async () => {
    const append = vi.fn().mockRejectedValue(new Error('snapshot down'));
    const test = input({ proceed: true, enforcementMode: 'shadow', snapshot, accessDecision }, append);
    await expect(appendResolvedRunSnapshot(test.value)).resolves.toBeUndefined();
    expect(test.warn).toHaveBeenCalledWith(expect.stringContaining('snapshot unavailable'));
  });

  it('enforce 模式 Snapshot 持久化失败必须阻断运行', async () => {
    const append = vi.fn().mockRejectedValue(new Error('snapshot down'));
    const test = input({ proceed: true, enforcementMode: 'enforce', snapshot, accessDecision }, append);
    await expect(appendResolvedRunSnapshot(test.value)).rejects.toThrow('snapshot down');
  });

  it('enforce 访问拒绝时不得落 Snapshot，直接阻断运行', async () => {
    const test = input({ proceed: false, enforcementMode: 'enforce', snapshot, accessDecision });
    await expect(appendResolvedRunSnapshot(test.value)).rejects.toThrow('ASSIGNMENT_REQUIRED');
    expect(test.append).not.toHaveBeenCalled();
  });
});
