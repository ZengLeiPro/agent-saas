import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import type {
  HandRecord,
  HandStatus,
  HandStore,
  RegisterHandInput,
} from '../runtime/handStore.js';
import { ensureRuntimeHandRegistered } from '../runtime/runtimeHandRegistration.js';

class CasMemoryHandStore implements HandStore {
  record: HandRecord | null = null;

  async register(input: RegisterHandInput): Promise<HandRecord> {
    const now = new Date().toISOString();
    this.record = {
      handId: input.handId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      type: input.type,
      status: input.status ?? 'ready',
      endpoint: input.endpoint,
      capabilities: input.capabilities ?? [],
      recipeDigest: input.recipeDigest,
      createdAt: this.record?.createdAt ?? now,
      updatedAt: now,
      metadata: { ...(this.record?.metadata ?? {}), ...(input.metadata ?? {}) },
    };
    return this.record;
  }

  async completeProvisionAttempt(
    handId: string,
    generation: string,
    status: HandStatus,
    metadata: Record<string, unknown> = {},
  ): Promise<HandRecord | null> {
    if (this.record?.handId !== handId || this.record.status !== 'provisioning'
      || this.record.metadata.provisionGeneration !== generation) return null;
    return await this.updateStatus(handId, status, metadata);
  }

  async updateStatus(
    handId: string,
    status: HandStatus,
    metadata: Record<string, unknown> = {},
  ): Promise<HandRecord | null> {
    if (this.record?.handId !== handId) return null;
    this.record = {
      ...this.record,
      status,
      updatedAt: new Date().toISOString(),
      metadata: { ...this.record.metadata, ...metadata },
    };
    return this.record;
  }

  async claimProvisionRecovery(): Promise<HandRecord | null> { return null; }
  async completeProvisionRecovery(): Promise<HandRecord | null> { return null; }
  async get(handId: string): Promise<HandRecord | null> { return this.record?.handId === handId ? this.record : null; }
  async listBySession(sessionId: string): Promise<HandRecord[]> { return this.record?.sessionId === sessionId ? [this.record] : []; }
  async listByWorkspace(workspaceId: string): Promise<HandRecord[]> { return this.record?.workspaceId === workspaceId ? [this.record] : []; }
}

describe('runtime Hand provision contracts and generation CAS', () => {
  it('persists the serverRemote credential reference without persisting its plaintext token', async () => {
    const handStore = new CasMemoryHandStore();
    const common = {
      handStore,
      eventStore: { append: vi.fn().mockResolvedValue(undefined) } as never,
      executionTransportRegistry: { has: () => false, get: () => undefined } as never,
      executionTarget: 'server-remote' as const,
      sessionId: 'session-credential', workspaceId: 'workspace-credential', tenantId: 'tenant-credential',
    };

    await ensureRuntimeHandRegistered({
      ...common, serverRemoteAuthTokenRef: 'secret://server-remote/original',
    });
    expect(handStore.record?.metadata).toMatchObject({
      serverRemoteAuthTokenRef: 'secret://server-remote/original',
    });
    expect(JSON.stringify(handStore.record?.metadata)).not.toContain('plaintext-token');

    await ensureRuntimeHandRegistered(common);
    expect(handStore.record?.metadata.serverRemoteAuthTokenRef).toBeNull();
  });

  it('maps the persisted sandbox profile into server-remote recipe resources', async () => {
    const handStore = new CasMemoryHandStore();
    const provision = vi.fn(async () => ({ status: 'ok' as const }));

    await ensureRuntimeHandRegistered({
      handStore,
      eventStore: { append: vi.fn().mockResolvedValue(undefined) } as never,
      executionTransportRegistry: {
        has: () => true,
        get: () => ({ listInternalTools: () => [], provision }),
      } as never,
      executionTarget: 'server-remote',
      sessionId: 'session-profile',
      workspaceId: 'workspace-profile',
      runId: 'run-profile',
      tenantId: 'tenant-profile',
      sandboxProfile: 'daily',
      serverRemoteRecipe: { resources: { diskMb: 8192 } },
    });

    expect(provision).toHaveBeenCalledWith(expect.objectContaining({
      resources: { cpu: '1', memoryMb: 2048, diskMb: 8192 },
    }));
  });

  it('lets a child hand inherit the parent effective resources over its profile recipe', async () => {
    const handStore = new CasMemoryHandStore();
    const provision = vi.fn(async () => ({ status: 'ok' as const }));
    await ensureRuntimeHandRegistered({
      handStore,
      eventStore: { append: vi.fn().mockResolvedValue(undefined) } as never,
      executionTransportRegistry: { has: () => true, get: () => ({ listInternalTools: () => [], provision }) } as never,
      executionTarget: 'server-remote',
      sessionId: 'child-session',
      workspaceId: 'parent-workspace',
      tenantId: 'tenant-child',
      sandboxProfile: 'daily',
      sandboxResources: { cpu: '4', memoryMb: 8192 },
      serverRemoteRecipe: { resources: { diskMb: 16384 } },
    });
    expect(provision).toHaveBeenCalledWith(expect.objectContaining({
      resources: { cpu: '4', memoryMb: 8192, diskMb: 16384 },
    }));
  });

  it('tenant provision overrides static workload with taskboard/cron/memory while preserving static recipe fields', async () => {
    const cases = [
      [
        { kind: 'taskboard' as const, taskKind: 'delivery' as const, purpose: 'review' as const },
        { class: 'taskboard', taskKind: 'delivery', purpose: 'review' },
      ],
      [{ kind: 'cron' as const }, { class: 'cron' }],
      [{ kind: 'memory' as const }, { class: 'memory' }],
    ] as const;
    const digests = new Set<string>(); // Distinct values prove workload participates in the effective digest.

    for (const [sandboxWorkloadDescriptor, expectedWorkload] of cases) {
      const handStore = new CasMemoryHandStore();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      try {
        await ensureRuntimeHandRegistered({
          handStore,
          eventStore: { append: vi.fn().mockResolvedValue(undefined) } as never,
          executionTransportRegistry: {
            has: () => false,
            get: () => { throw new Error('no default execution transport expected'); },
          } as never,
          executionTarget: 'server-local',
          sessionId: `tenant-${sandboxWorkloadDescriptor.kind}`,
          workspaceId: 'workspace-tenant',
          workspaceMountSubPath: 'dynamic/mount-must-not-win',
          topLevelSessionId: 'top-session',
          tenantId: 'tenant-1',
          userTenantId: 'tenant-1',
          userId: 'user-1',
          sandboxWorkloadDescriptor,
          tenantRemoteHands: [{
            id: 'tenant-acs',
            baseUrl: 'https://tenant-hand.example',
            authToken: 'static-config-token',
            recipe: {
              mountSubPath: 'static/mount',
              repo: { url: 'https://git.example/repo.git', ref: 'main', remote: 'origin' },
              resources: { cpu: '2', memoryMb: 4096 },
              packages: ['git'],
              setupCommands: ['pnpm install --frozen-lockfile'],
              workload: { class: 'interactive' },
            },
          }],
          tenantRemoteHandResolver: {
            resolveForRegister: vi.fn(async () => ({
              id: 'tenant-acs',
              baseUrl: 'https://tenant-hand.example',
              authToken: 'resolved-token',
              source: 'inline' as const,
            })),
            resolveForHand: vi.fn(async () => 'resolved-token'),
          },
        });

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, init] = fetchSpy.mock.calls[0]!;
        expect(url).toBe('https://tenant-hand.example/provision');
        expect((init as RequestInit).method).toBe('POST');
        expect((init as { headers: Record<string, string> }).headers.authorization).toBe('Bearer resolved-token');
        const request = JSON.parse(String((init as RequestInit).body));
        const expectedRecipe = {
          mountSubPath: 'static/mount',
          repo: { url: 'https://git.example/repo.git', ref: 'main', remote: 'origin' },
          resources: { cpu: '2', memoryMb: 4096 },
          packages: ['git'],
          setupCommands: ['pnpm install --frozen-lockfile'],
          workload: expectedWorkload,
          workspaceId: 'workspace-tenant',
          sandboxScopeId: 'workspace-tenant__static_mount__s_top-session',
          sessionId: `tenant-${sandboxWorkloadDescriptor.kind}`,
        };
        expect(request).toEqual({ workspaceId: 'workspace-tenant', recipe: expectedRecipe });
        const expectedDigest = createHash('sha256').update(JSON.stringify(expectedRecipe)).digest('hex');
        expect(handStore.record).toMatchObject({
          handId: `tenant-${sandboxWorkloadDescriptor.kind}:tenant-acs`,
          recipeDigest: expectedDigest,
          metadata: { recipe: expectedRecipe },
        });
        digests.add(handStore.record!.recipeDigest!);
      } finally {
        fetchSpy.mockRestore();
      }
    }

    expect(digests.size).toBe(3);
  });

  it('keeps environment-template resources authoritative over the session profile', async () => {
    const handStore = new CasMemoryHandStore();
    const provision = vi.fn(async () => ({ status: 'ok' as const }));
    const environmentStore = {
      getInstance: vi.fn(async () => null),
      getTemplateVersion: vi.fn(async () => ({
        versionId: 'version-1',
        templateId: 'template-1',
        digest: 'template-digest',
        recipe: {
          packages: [],
          envKeys: [],
          setupCommands: [],
          resources: { cpu: '4', memoryMb: 8192, diskMb: 16384 },
        },
      })),
      getProvider: vi.fn(async () => ({ status: 'enabled' })),
      getTemplate: vi.fn(async () => ({ status: 'published' })),
      upsert: vi.fn(async () => undefined),
      create: vi.fn(async (input) => input),
      transition: vi.fn(async () => undefined),
    };

    await ensureRuntimeHandRegistered({
      handStore,
      eventStore: { append: vi.fn().mockResolvedValue(undefined) } as never,
      executionTransportRegistry: {
        has: () => true,
        get: () => ({ listInternalTools: () => [], provision }),
      } as never,
      executionTarget: 'server-remote',
      sessionId: 'session-template',
      workspaceId: 'workspace-template',
      runId: 'run-template',
      tenantId: 'tenant-template',
      userTenantId: 'tenant-template',
      userId: 'user-template',
      sandboxProfile: 'daily',
      environmentStore: environmentStore as never,
      environmentTemplateVersionId: 'version-1',
      authorizeEnvironmentTemplate: vi.fn(async () => true),
    });

    expect(provision).toHaveBeenCalledWith(expect.objectContaining({
      resources: { cpu: '4', memoryMb: 8192, diskMb: 16384 },
    }));
  });

  it('merges partial environment resources over the profile and digests the effective recipe', async () => {
    const cases = [
      [{ diskMb: 8192 }, { cpu: '1', memoryMb: 2048, diskMb: 8192 }],
      [{ timeoutMs: 60_000 }, { cpu: '1', memoryMb: 2048, timeoutMs: 60_000 }],
      [{ cpu: '4' }, { cpu: '4', memoryMb: 2048 }],
      [{ memoryMb: 8192 }, { cpu: '1', memoryMb: 8192 }],
    ] as const;
    for (const [templateResources, expectedResources] of cases) {
      const handStore = new CasMemoryHandStore();
      const provision = vi.fn(async () => ({ status: 'ok' as const }));
      const environmentStore = {
        getInstance: vi.fn(async () => null),
        getTemplateVersion: vi.fn(async () => ({
          versionId: 'version-partial', templateId: 'template-partial', digest: 'template-only-digest',
          recipe: { packages: [], envKeys: [], setupCommands: [], resources: templateResources },
        })),
        getProvider: vi.fn(async () => ({ status: 'enabled' })),
        getTemplate: vi.fn(async () => ({ status: 'published' })),
        upsert: vi.fn(async () => undefined), create: vi.fn(async (input) => input), transition: vi.fn(async () => undefined),
      };
      await ensureRuntimeHandRegistered({
        handStore,
        eventStore: { append: vi.fn().mockResolvedValue(undefined) } as never,
        executionTransportRegistry: { has: () => true, get: () => ({ listInternalTools: () => [], provision }) } as never,
        executionTarget: 'server-remote', sessionId: `session-${Object.keys(templateResources)[0]}`,
        workspaceId: 'workspace-partial', tenantId: 'tenant-partial', userTenantId: 'tenant-partial', userId: 'user-partial',
        sandboxProfile: 'daily', environmentStore: environmentStore as never, environmentTemplateVersionId: 'version-partial',
        authorizeEnvironmentTemplate: vi.fn(async () => true),
      });
      const recipe = handStore.record?.metadata.recipe;
      expect(recipe).toMatchObject({ resources: expectedResources });
      expect(handStore.record?.recipeDigest).toBe(createHash('sha256').update(JSON.stringify(recipe)).digest('hex'));
      expect(environmentStore.create).toHaveBeenCalledWith(expect.objectContaining({ recipeDigest: 'template-only-digest' }));
    }
  });

  it('does not let an older slow failure overwrite a newer successful attempt', async () => {
    const handStore = new CasMemoryHandStore();
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstProvision = vi.fn(async () => {
      markFirstStarted();
      await firstGate;
      return { status: 'error' as const, error: 'older failure' };
    });
    const secondProvision = vi.fn(async () => ({ status: 'ok' as const }));
    const base = {
      handStore,
      eventStore: { append: vi.fn().mockResolvedValue(undefined) } as never,
      executionTarget: 'server-local' as const,
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      runId: 'run-1',
      tenantId: 'tenant-runtime-hand-race',
    };

    const first = ensureRuntimeHandRegistered({
      ...base,
      executionTransportRegistry: { has: () => true, get: () => ({ listInternalTools: () => [], provision: firstProvision }) } as never,
    });
    await firstStarted;
    await ensureRuntimeHandRegistered({
      ...base,
      executionTransportRegistry: { has: () => true, get: () => ({ listInternalTools: () => [], provision: secondProvision }) } as never,
    });
    releaseFirst();
    await expect(first).resolves.toBeUndefined();

    expect(handStore.record).toMatchObject({
      status: 'ready',
      metadata: { provisionFailure: null, provision: { lastStatus: 'ok' } },
    });
  });
});
