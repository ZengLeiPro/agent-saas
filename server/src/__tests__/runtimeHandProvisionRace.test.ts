import { createHash } from 'node:crypto'; // recipe and stable provision-key assertions
import { describe, expect, it, vi } from 'vitest';

// Fixed child identities must make default and tenant hand provisioning safely repeatable after a crash.

import type {
  HandRecord,
  HandStatus,
  HandStore,
  RegisterHandInput,
  WorkspaceRecipe,
} from '../runtime/handStore.js';
import { HandHealthScanner } from '../runtime/handHealthScanner.js';
import { deriveProvisionIdentity, ensureRuntimeHandRegistered } from '../runtime/runtimeHandRegistration.js';

// Single-record store covers default-hand CAS; tenant dispatch claims and completion certainty use the map fixture below.
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

class MapMemoryHandStore implements HandStore {
  records = new Map<string, HandRecord>();
  async register(input: RegisterHandInput): Promise<HandRecord> {
    const previous = this.records.get(input.handId);
    const now = new Date().toISOString();
    const record: HandRecord = {
      handId: input.handId, sessionId: input.sessionId, workspaceId: input.workspaceId, type: input.type,
      status: input.status ?? 'ready', endpoint: input.endpoint, capabilities: input.capabilities ?? [],
      recipeDigest: input.recipeDigest, createdAt: previous?.createdAt ?? now, updatedAt: now,
      metadata: { ...(previous?.metadata ?? {}), ...(input.metadata ?? {}) },
    };
    this.records.set(input.handId, record); return record;
  }
  async claimProvisionDispatch(handId: string, generation: string, dispatchToken: string, expectedUpdatedAt: string) {
    const record = this.records.get(handId);
    if (!record || record.status !== 'provisioning' || record.metadata.provisionGeneration !== generation
      || record.metadata.reconcileRequired === true || record.metadata.provisionDispatchClaim
      || record.updatedAt !== expectedUpdatedAt) return null;
    return this.updateStatus(handId, 'unhealthy', {
      provisionDispatchClaim: dispatchToken,
      provisionDispatchClaimedAt: new Date().toISOString(),
      provisionResult: 'result_unknown', reconcileRequired: true, dispatchAuthorized: true,
    });
  }
  async completeProvisionDispatch(handId: string, generation: string, dispatchToken: string, status: 'ready' | 'unhealthy', metadata: Record<string, unknown> = {}) {
    const record = this.records.get(handId);
    if (!record || !['provisioning', 'unhealthy'].includes(record.status)
      || record.metadata.provisionGeneration !== generation
      || record.metadata.provisionDispatchClaim !== dispatchToken
      || record.metadata.dispatchAuthorized !== true) return null;
    return this.updateStatus(handId, status, {
      ...metadata,
      provisionDispatchClaim: null,
      dispatchAuthorized: false,
      provisionResult: status === 'ready' ? 'ok' : (metadata.provisionResult ?? 'error'),
      reconcileRequired: metadata.reconcileRequired ?? status !== 'ready',
    });
  }
  async completeProvisionAttempt(handId: string, generation: string, status: HandStatus, metadata: Record<string, unknown> = {}) {
    const record = this.records.get(handId);
    if (!record || record.status !== 'provisioning' || record.metadata.provisionGeneration !== generation) return null;
    return this.updateStatus(handId, status, metadata);
  }
  async updateStatus(handId: string, status: HandStatus, metadata: Record<string, unknown> = {}) {
    const record = this.records.get(handId); if (!record) return null;
    const updated = { ...record, status, updatedAt: new Date().toISOString(), metadata: { ...record.metadata, ...metadata } };
    this.records.set(handId, updated); return updated;
  }
  async claimProvisionRecovery(): Promise<HandRecord | null> { return null; }
  async completeProvisionRecovery(): Promise<HandRecord | null> { return null; }
  async get(handId: string) { return this.records.get(handId) ?? null; }
  async listBySession(sessionId: string) { return [...this.records.values()].filter(record => record.sessionId === sessionId); }
  async listByWorkspace(workspaceId: string) { return [...this.records.values()].filter(record => record.workspaceId === workspaceId); }
  async listByType(type: HandRecord['type'], options?: { status?: HandStatus }) {
    return [...this.records.values()].filter(record => record.type === type
      && (!options?.status || record.status === options.status));
  }
}

describe('runtime Hand atomic provision attempt authority', () => {
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

  it('derives a stable secret-free provision identity while leaving fresh transport URLs intact', () => {
    const recipe: WorkspaceRecipe = {
      workspaceId: 'workspace-identity',
      sandboxScopeId: 'scope-identity',
      repo: { url: 'https://oauth-user:repo-secret@git.example/repo.git?token=repo-token', ref: 'main' },
      files: [{
        artifactId: 'artifact-stable', path: 'seed/data.txt',
        url: 'https://files.example/download?credential=file-secret',
        signedUrl: 'https://signed.example/download?X-Amz-Signature=signed-secret',
      }],
      packages: ['tsx@4.19.0'],
    };
    const rotatedRecipe: WorkspaceRecipe = {
      ...recipe,
      repo: { ...recipe.repo!, url: 'https://other-user:new-secret@git.example/repo.git?token=new-token' },
      files: recipe.files!.map((file) => ({
        ...file,
        url: 'https://temporary.example/new-host?credential=new-file-secret',
        signedUrl: 'https://signed.example/download?X-Amz-Signature=new-signed-secret',
      })),
    };

    const originalKey = deriveProvisionIdentity('hand-identity', 'fixed-child-run', recipe);
    const rotatedKey = deriveProvisionIdentity('hand-identity', 'fixed-child-run', rotatedRecipe);
    expect(rotatedKey).toBe(originalKey);
    const differentRepoKey = deriveProvisionIdentity('hand-identity', 'fixed-child-run', {
      ...rotatedRecipe,
      repo: { ...rotatedRecipe.repo!, url: 'https://user:repo-secret@git.example/other.git?token=repo-token#fragment' },
    });
    expect(differentRepoKey).not.toBe(originalKey);
    expect(originalKey).toMatch(/^[a-f0-9]{64}$/);
    expect(originalKey).not.toMatch(/secret|token|oauth|signature/i);
    expect(differentRepoKey).not.toMatch(/secret|token|oauth|signature/i);
    expect(rotatedRecipe.repo?.url).toContain('new-secret');
    expect(rotatedRecipe.files?.[0]?.signedUrl).toContain('new-signed-secret');
    expect(deriveProvisionIdentity('hand-identity', 'fixed-child-run', {
      ...rotatedRecipe,
      files: [{ ...rotatedRecipe.files![0]!, path: 'seed/changed.txt' }],
    })).not.toBe(originalKey);
  });

  it('does not let an older slow failure overwrite a newer successful attempt', async () => {
    const handStore = new CasMemoryHandStore();
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstProvision = vi.fn(async (_recipe: { provisionKey?: string }) => {
      markFirstStarted();
      await firstGate;
      return { status: 'error' as const, error: 'older failure' };
    });
    const secondProvision = vi.fn(async (_recipe: { provisionKey?: string }) => ({ status: 'ok' as const }));
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
      metadata: {
        provisionKey: expect.any(String),
        provisionFailure: null,
        provision: { lastStatus: 'ok' },
      },
    });
    expect(firstProvision.mock.calls[0]![0].provisionKey)
      .toBe(secondProvision.mock.calls[0]![0].provisionKey);
  });

  it('keeps claimed dispatch authority stable when scanner runs before the original request', async () => {
    const handStore = new MapMemoryHandStore();
    const fetchImpl = vi.fn(async (url: string | URL | Request) => new Response(
      JSON.stringify({ status: 'ok' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchImpl);
    const scanner = new HandHealthScanner({
      handStore,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveHandAuthToken: () => 'token',
    });
    let claimedToken: unknown;
    const beforeDispatch = vi.fn(async () => {
      const claimed = handStore.records.get('scanner-race-session:tenant-ecs')!;
      claimedToken = claimed.metadata.provisionDispatchClaim;
      expect(claimed).toMatchObject({ status: 'unhealthy', metadata: {
        provisionResult: 'result_unknown', reconcileRequired: true, dispatchAuthorized: true,
      } });
      expect(await scanner.scanOnce()).toEqual({ scanned: 1, flipped: 0 });
      expect(handStore.records.get(claimed.handId)?.metadata.provisionDispatchClaim).toBe(claimedToken);
    });

    await ensureRuntimeHandRegistered({
      handStore,
      eventStore: { append: vi.fn().mockResolvedValue(undefined) } as never,
      executionTransportRegistry: { has: () => true, get: () => ({ listInternalTools: () => [] }) } as never,
      executionTarget: 'server-local', sessionId: 'scanner-race-session', runId: 'scanner-race-run',
      workspaceId: 'scanner-race-workspace', tenantId: 'tenant-a', userTenantId: 'tenant-a', userId: 'user-a',
      tenantRemoteHands: [{ id: 'tenant-ecs', baseUrl: 'https://tenant.example', tenantIds: ['tenant-a'] }],
      tenantRemoteHandResolver: { resolveForRegister: vi.fn(async () => ({ authToken: 'token', source: 'inline' })) } as never,
      beforeTenantRemoteProvision: beforeDispatch,
    });
    await vi.waitFor(() => expect(handStore.records.get('scanner-race-session:tenant-ecs')).toMatchObject({
      status: 'ready', metadata: { reconcileRequired: false, dispatchAuthorized: false, provisionResult: 'ok' },
    }));

    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes('/provision'))).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it('leaves an accepted in-flight tenant provision as result_unknown and never replays it', async () => {
    const handStore = new MapMemoryHandStore();
    let release!: () => void;
    let accepted!: () => void;
    const acceptedPromise = new Promise<void>(resolve => { accepted = resolve; });
    const responseGate = new Promise<void>(resolve => { release = resolve; });
    const fetchImpl = vi.fn(async () => {
      accepted(); await responseGate;
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchImpl);
    const beforeDispatch = vi.fn(async () => undefined);
    const params = {
      handStore,
      eventStore: { append: vi.fn().mockResolvedValue(undefined) } as never,
      executionTransportRegistry: { has: () => true, get: () => ({ listInternalTools: () => [] }) } as never,
      executionTarget: 'server-local' as const,
      sessionId: 'tenant-child-session', runId: 'tenant-fixed-child-run', workspaceId: 'workspace-tenant',
      tenantId: 'tenant-a', userTenantId: 'tenant-a', userId: 'user-a',
      tenantRemoteHands: [{ id: 'tenant-ecs', baseUrl: 'https://tenant.example', tenantIds: ['tenant-a'] }],
      tenantRemoteHandResolver: { resolveForRegister: vi.fn(async () => ({ authToken: 'token', source: 'inline' })) } as never,
      beforeTenantRemoteProvision: beforeDispatch,
    };
    await ensureRuntimeHandRegistered(params);
    await acceptedPromise;
    const first = handStore.records.get('tenant-child-session:tenant-ecs')!;
    expect(first).toMatchObject({ status: 'unhealthy', metadata: {
      provisionKey: expect.any(String), provisionGeneration: expect.any(String),
      provisionResult: 'result_unknown', reconcileRequired: true, dispatchAuthorized: true,
      provisionDispatchClaim: expect.any(String),
    } });
    expect(first.metadata.provisionKey).toBe(first.metadata.provisionGeneration);

    await ensureRuntimeHandRegistered(params);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(handStore.records.get('tenant-child-session:tenant-ecs')).toMatchObject({
      status: 'unhealthy', metadata: { provisionResult: 'result_unknown', reconcileRequired: true,
        provisionGeneration: first.metadata.provisionGeneration,
        provisionDispatchClaim: first.metadata.provisionDispatchClaim },
    });
    await ensureRuntimeHandRegistered(params);
    expect(fetchImpl).toHaveBeenCalledOnce();
    release();
    await new Promise(resolve => setTimeout(resolve, 0));
    vi.unstubAllGlobals();
  });

  it('replaces an unknown G1 dispatch fence when a recipe change installs G2', async () => {
    const handStore = new MapMemoryHandStore();
    let releaseG1!: () => void;
    let releaseG2!: () => void;
    let acceptedG1!: () => void;
    let acceptedG2!: () => void;
    const acceptedG1Promise = new Promise<void>(resolve => { acceptedG1 = resolve; });
    const acceptedG2Promise = new Promise<void>(resolve => { acceptedG2 = resolve; });
    const g1ResponseGate = new Promise<void>(resolve => { releaseG1 = resolve; });
    const g2ResponseGate = new Promise<void>(resolve => { releaseG2 = resolve; });
    const fetchImpl = vi.fn()
      .mockImplementationOnce(async () => {
        acceptedG1();
        await g1ResponseGate;
        throw new Error('G1 response lost');
      })
      .mockImplementationOnce(async () => {
        acceptedG2();
        await g2ResponseGate;
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      });
    vi.stubGlobal('fetch', fetchImpl);
    const baseParams = {
      handStore,
      eventStore: { append: vi.fn().mockResolvedValue(undefined) } as never,
      executionTransportRegistry: { has: () => true, get: () => ({ listInternalTools: () => [] }) } as never,
      executionTarget: 'server-local' as const,
      sessionId: 'cross-generation-session', runId: 'cross-generation-run', workspaceId: 'cross-generation-workspace',
      tenantId: 'tenant-a', userTenantId: 'tenant-a', userId: 'user-a',
      tenantRemoteHandResolver: { resolveForRegister: vi.fn(async () => ({ authToken: 'token', source: 'inline' })) } as never,
    };
    const g1Params = {
      ...baseParams,
      tenantRemoteHands: [{ id: 'tenant-ecs', baseUrl: 'https://tenant.example', tenantIds: ['tenant-a'],
        recipe: { setupCommands: ['echo G1'] } }],
    };
    await ensureRuntimeHandRegistered(g1Params);
    await acceptedG1Promise;
    const g1 = handStore.records.get('cross-generation-session:tenant-ecs')!;
    expect(g1).toMatchObject({ status: 'unhealthy', metadata: {
      provisionResult: 'result_unknown', reconcileRequired: true, dispatchAuthorized: true,
      provisionDispatchClaim: expect.any(String),
    } });

    const g2Params = {
      ...baseParams,
      tenantRemoteHands: [{ id: 'tenant-ecs', baseUrl: 'https://tenant.example', tenantIds: ['tenant-a'],
        recipe: { setupCommands: ['echo G2'] } }],
    };
    await ensureRuntimeHandRegistered(g2Params);
    await acceptedG2Promise;
    const g2 = handStore.records.get('cross-generation-session:tenant-ecs')!;
    expect(g2.metadata.provisionGeneration).not.toBe(g1.metadata.provisionGeneration);
    expect(g2).toMatchObject({ status: 'unhealthy', metadata: {
      provisionResult: 'result_unknown', reconcileRequired: true, dispatchAuthorized: true,
      provisionDispatchClaim: expect.any(String),
    } });
    expect(g2.metadata.provisionDispatchClaim).not.toBe(g1.metadata.provisionDispatchClaim);

    // A normal repeat registration for G2 must preserve its live fence rather than roll it back.
    await ensureRuntimeHandRegistered(g2Params);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(handStore.records.get(g2.handId)?.metadata.provisionDispatchClaim)
      .toBe(g2.metadata.provisionDispatchClaim);

    releaseG2();
    await vi.waitFor(() => expect(handStore.records.get(g2.handId)).toMatchObject({
      status: 'ready', metadata: { provisionGeneration: g2.metadata.provisionGeneration,
        provisionResult: 'ok', reconcileRequired: false, dispatchAuthorized: false,
        provisionDispatchClaim: null },
    }));
    releaseG1();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(handStore.records.get(g2.handId)).toMatchObject({
      status: 'ready', metadata: { provisionGeneration: g2.metadata.provisionGeneration, provisionResult: 'ok' },
    });
    vi.unstubAllGlobals();
  });

  it('completes a rejected final live barrier as not_dispatched and can recover with the same key', async () => {
    const handStore = new MapMemoryHandStore();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchImpl);
    let live = false;
    const params = {
      handStore,
      eventStore: { append: vi.fn().mockResolvedValue(undefined) } as never,
      executionTransportRegistry: { has: () => true, get: () => ({ listInternalTools: () => [] }) } as never,
      executionTarget: 'server-local' as const, sessionId: 'claim-barrier-session', runId: 'claim-barrier-run',
      workspaceId: 'claim-barrier-workspace', tenantId: 'tenant-a', userTenantId: 'tenant-a', userId: 'user-a',
      tenantRemoteHands: [{ id: 'tenant-ecs', baseUrl: 'https://tenant.example', tenantIds: ['tenant-a'] }],
      tenantRemoteHandResolver: { resolveForRegister: vi.fn(async () => ({ authToken: 'token', source: 'inline' })) } as never,
      beforeTenantRemoteProvision: async () => { if (!live) throw new Error('dispatch disabled'); },
    };

    await ensureRuntimeHandRegistered(params);
    await vi.waitFor(() => expect(handStore.records.get('claim-barrier-session:tenant-ecs')).toMatchObject({
      status: 'unhealthy', metadata: {
        provisionResult: 'not_dispatched', reconcileRequired: false,
        dispatchAuthorized: false, provisionDispatchClaim: null,
      },
    }));
    expect(fetchImpl).not.toHaveBeenCalled();
    const stableKey = handStore.records.get('claim-barrier-session:tenant-ecs')!.metadata.provisionKey;

    live = true;
    await ensureRuntimeHandRegistered(params);
    await vi.waitFor(() => expect(handStore.records.get('claim-barrier-session:tenant-ecs')).toMatchObject({
      status: 'ready', metadata: { provisionResult: 'ok', reconcileRequired: false },
    }));
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(handStore.records.get('claim-barrier-session:tenant-ecs')!.metadata.provisionKey).toBe(stableKey);
    vi.unstubAllGlobals();
  });

  it('treats an explicit provider error as known and retryable without reconciliation', async () => {
    const handStore = new MapMemoryHandStore();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'error', error: 'provider rejected' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'ok' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchImpl);

    await ensureRuntimeHandRegistered({
      handStore,
      eventStore: { append: vi.fn().mockResolvedValue(undefined) } as never,
      executionTransportRegistry: { has: () => true, get: () => ({ listInternalTools: () => [] }) } as never,
      executionTarget: 'server-local', sessionId: 'known-error-session', runId: 'known-error-run',
      workspaceId: 'known-error-workspace', tenantId: 'tenant-a', userTenantId: 'tenant-a', userId: 'user-a',
      tenantRemoteHands: [{ id: 'tenant-ecs', baseUrl: 'https://tenant.example', tenantIds: ['tenant-a'] }],
      tenantRemoteHandResolver: { resolveForRegister: vi.fn(async () => ({ authToken: 'token', source: 'inline' })) } as never,
    });

    await vi.waitFor(() => expect(handStore.records.get('known-error-session:tenant-ecs')).toMatchObject({
      status: 'unhealthy', metadata: {
        provisionFailure: 'provider rejected', provisionResult: 'error', reconcileRequired: false,
        dispatchAuthorized: false, provisionDispatchClaim: null,
      },
    }));
    const stableKey = handStore.records.get('known-error-session:tenant-ecs')!.metadata.provisionKey;
    await ensureRuntimeHandRegistered({
      handStore,
      eventStore: { append: vi.fn().mockResolvedValue(undefined) } as never,
      executionTransportRegistry: { has: () => true, get: () => ({ listInternalTools: () => [] }) } as never,
      executionTarget: 'server-local', sessionId: 'known-error-session', runId: 'known-error-run',
      workspaceId: 'known-error-workspace', tenantId: 'tenant-a', userTenantId: 'tenant-a', userId: 'user-a',
      tenantRemoteHands: [{ id: 'tenant-ecs', baseUrl: 'https://tenant.example', tenantIds: ['tenant-a'] }],
      tenantRemoteHandResolver: { resolveForRegister: vi.fn(async () => ({ authToken: 'token', source: 'inline' })) } as never,
    });
    await vi.waitFor(() => expect(handStore.records.get('known-error-session:tenant-ecs')).toMatchObject({
      status: 'ready', metadata: { provisionResult: 'ok', reconcileRequired: false },
    }));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(handStore.records.get('known-error-session:tenant-ecs')!.metadata.provisionKey).toBe(stableKey);
    vi.unstubAllGlobals();
  });

  it('keeps reconciliation required when transport starts and then loses the response', async () => {
    const handStore = new MapMemoryHandStore();
    const fetchImpl = vi.fn(async () => ({
      json: async () => ({ status: 'ok' }),
      get ok() { throw new Error('response lost'); },
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchImpl);

    await ensureRuntimeHandRegistered({
      handStore,
      eventStore: { append: vi.fn().mockResolvedValue(undefined) } as never,
      executionTransportRegistry: { has: () => true, get: () => ({ listInternalTools: () => [] }) } as never,
      executionTarget: 'server-local', sessionId: 'unknown-result-session', runId: 'unknown-result-run',
      workspaceId: 'unknown-result-workspace', tenantId: 'tenant-a', userTenantId: 'tenant-a', userId: 'user-a',
      tenantRemoteHands: [{ id: 'tenant-ecs', baseUrl: 'https://tenant.example', tenantIds: ['tenant-a'] }],
      tenantRemoteHandResolver: { resolveForRegister: vi.fn(async () => ({ authToken: 'token', source: 'inline' })) } as never,
    });

    await vi.waitFor(() => expect(handStore.records.get('unknown-result-session:tenant-ecs')).toMatchObject({
      status: 'unhealthy', metadata: {
        provisionFailure: 'response lost', provisionResult: 'result_unknown', reconcileRequired: true,
      },
    }));
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(handStore.records.get('unknown-result-session:tenant-ecs')?.metadata.dispatchAuthorized).toBe(false);
    vi.unstubAllGlobals();
  });

  it('authorizes at most one remote request across concurrent registrations', async () => {
    const handStore = new MapMemoryHandStore();
    let release!: () => void;
    let claimed!: () => void;
    const claimedPromise = new Promise<void>(resolve => { claimed = resolve; });
    const dispatchGate = new Promise<void>(resolve => { release = resolve; });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchImpl);
    const beforeTenantRemoteProvision = vi.fn(async () => { claimed(); await dispatchGate; });
    const params = {
      handStore,
      eventStore: { append: vi.fn().mockResolvedValue(undefined) } as never,
      executionTransportRegistry: { has: () => true, get: () => ({ listInternalTools: () => [] }) } as never,
      executionTarget: 'server-local' as const,
      sessionId: 'concurrent-claim-session', runId: 'concurrent-claim-run', workspaceId: 'concurrent-claim-workspace',
      tenantId: 'tenant-a', userTenantId: 'tenant-a', userId: 'user-a',
      tenantRemoteHands: [{ id: 'tenant-ecs', baseUrl: 'https://tenant.example', tenantIds: ['tenant-a'] }],
      tenantRemoteHandResolver: { resolveForRegister: vi.fn(async () => ({ authToken: 'token', source: 'inline' })) } as never,
      beforeTenantRemoteProvision,
    };
    const first = ensureRuntimeHandRegistered(params);
    await claimedPromise;
    await ensureRuntimeHandRegistered(params);
    release();
    await first;
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());

    expect(beforeTenantRemoteProvision).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('skips provisioning when the fixed identity already has the same ready hand', async () => {
    const handStore = new CasMemoryHandStore();
    const provision = vi.fn(async () => ({ status: 'ok' as const }));
    const params = {
      handStore,
      eventStore: { append: vi.fn().mockResolvedValue(undefined) } as never,
      executionTransportRegistry: {
        has: () => true,
        get: () => ({ listInternalTools: () => [], provision }),
      } as never,
      executionTarget: 'server-local' as const,
      sessionId: 'fixed-child-session', workspaceId: 'workspace-1', runId: 'fixed-child-run',
      tenantId: 'tenant-runtime-hand-ready',
    };
    await ensureRuntimeHandRegistered(params);
    await ensureRuntimeHandRegistered(params);
    expect(provision).toHaveBeenCalledOnce();
    expect(handStore.record).toMatchObject({
      status: 'ready', metadata: { provisionKey: expect.any(String), provisionFailure: null },
    });
  });
});
