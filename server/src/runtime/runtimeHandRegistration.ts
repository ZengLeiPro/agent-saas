import { createHash } from 'crypto';

import type { PgEnvironmentStore } from '../data/environments/index.js';
import type { ExecutionTargetKind, ToolDescriptor } from '../agent/toolRuntime.js';
import type { ExecutionTransportRegistry } from './executionTransport.js';
import { HandManager } from './handManager.js';
import {
  SERVER_REMOTE_HAND_LEASE_MS,
  type HandCapability,
  type HandStore,
  type WorkspaceRecipe,
} from './handStore.js';
import { HttpTransport } from './httpTransport.js';
import {
  selectTenantRemoteHandsForRegistration,
  type TenantRemoteHandAuthTokenResolver,
} from './tenantRemoteHandResolver.js';
import type { EventStore } from './types.js';
import type { RawRuntimeRunDispatchConfig, TenantRemoteHandDispatchConfig } from './rawRuntimeRunDispatch.js';

export function deriveSandboxScopeId(input: { workspaceId: string; mountSubPath?: string }): string {
  return input.mountSubPath ? `${input.workspaceId}__${input.mountSubPath.replace(/[^A-Za-z0-9_-]+/g, '_')}` : input.workspaceId;
}

function buildWorkspaceRecipe(
  workspaceId: string,
  override?: Partial<WorkspaceRecipe>,
  sessionId?: string,
  mountSubPath?: string,
): WorkspaceRecipe {
  const effectiveMountSubPath = override?.mountSubPath ?? mountSubPath;
  return {
    ...(override ?? {}),
    workspaceId,
    sandboxScopeId: override?.sandboxScopeId ?? deriveSandboxScopeId({ workspaceId, mountSubPath: effectiveMountSubPath }),
    ...(sessionId ? { sessionId } : {}),
    ...(!override?.mountSubPath && mountSubPath ? { mountSubPath } : {}),
  };
}

export async function ensureRuntimeHandRegistered(params: {
  handStore?: HandStore;
  eventStore: EventStore;
  executionTransportRegistry: ExecutionTransportRegistry;
  executionTarget: ExecutionTargetKind;
  sessionId: string;
  runId?: string;
  workspaceId: string;
  workspaceMountSubPath?: string;
  endpoint?: string;
  serverRemoteRecipe?: Partial<WorkspaceRecipe>;
  tenantRemoteHands?: TenantRemoteHandDispatchConfig[];
  tenantRemoteHandResolver?: TenantRemoteHandAuthTokenResolver;
  environmentStore?: PgEnvironmentStore;
  environmentTemplateVersionId?: string;
  authorizeEnvironmentTemplate?: RawRuntimeRunDispatchConfig['authorizeEnvironmentTemplate'];
  agentId?: string;
  userId?: string;
  username?: string;
  /**
   * B1: Resolved requesting-user `tenantId`. When present, tenantRemoteHand
   * entries with a `tenantIds` allow-list attach if `userTenantId ∈ tenantIds`.
   * Combined with `users`: independently permissive (any match attaches).
   */
  userTenantId?: string;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}): Promise<void> {
  if (!params.handStore) return;
  const transport = params.executionTransportRegistry.has(params.executionTarget)
    ? params.executionTransportRegistry.get(params.executionTarget)
    : undefined;
  const tools = transport?.listInternalTools() ?? [];
  const capabilities: HandCapability[] = [workspaceCapability(
    'Workspace filesystem and shell hand',
    tools,
    params.executionTarget === 'server-remote'
      ? ['workspace.root is never serialized to the remote hand']
      : ['in-process compatibility hand'],
  )];
  const manager = new HandManager({
    handStore: params.handStore,
    transportRegistry: params.executionTransportRegistry,
    eventStore: params.eventStore,
  });
  const defaultHandId = `${params.sessionId}:${params.executionTarget}`;
  const currentEnvironmentInstance = params.environmentStore && params.userTenantId
    ? await params.environmentStore.getInstance(params.userTenantId, defaultHandId)
    : null;
  if (currentEnvironmentInstance && params.environmentTemplateVersionId
    && params.environmentTemplateVersionId !== currentEnvironmentInstance.templateVersionId) {
    throw new Error('ENVIRONMENT_INSTANCE_TEMPLATE_VERSION_IMMUTABLE');
  }
  const effectiveTemplateVersionId = currentEnvironmentInstance?.templateVersionId
    ?? params.environmentTemplateVersionId;
  const baseRecipe = buildWorkspaceRecipe(
    params.workspaceId,
    params.executionTarget === 'server-remote' ? params.serverRemoteRecipe : undefined,
    params.sessionId,
    params.workspaceMountSubPath,
  );
  const environmentVersion = params.environmentStore && effectiveTemplateVersionId
    ? await params.environmentStore.getTemplateVersion(effectiveTemplateVersionId)
    : undefined;
  if (effectiveTemplateVersionId && !environmentVersion) {
    throw new Error('ENVIRONMENT_INSTANCE_TEMPLATE_VERSION_INVALID');
  }
  if (environmentVersion) {
    const [provider, template] = await Promise.all([
      params.environmentStore!.getProvider(params.executionTarget),
      params.environmentStore!.getTemplate(environmentVersion.templateId),
    ]);
    if (!provider || provider.status !== 'enabled') throw new Error('ENVIRONMENT_PROVIDER_UNAVAILABLE');
    if (!template || template.status !== 'published') throw new Error('ENVIRONMENT_TEMPLATE_UNAVAILABLE');
    if (!params.userTenantId || !params.userId || !params.authorizeEnvironmentTemplate
      || !await params.authorizeEnvironmentTemplate({
        tenantId: params.userTenantId,
        userId: params.userId,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        templateId: environmentVersion.templateId,
      })) {
      throw new Error('ENVIRONMENT_TEMPLATE_ASSIGNMENT_REQUIRED');
    }
  }
  const recipe: WorkspaceRecipe = environmentVersion
    ? {
        ...baseRecipe,
        packages: [...environmentVersion.recipe.packages],
        envKeys: [...environmentVersion.recipe.envKeys],
        setupCommands: [
          ...(baseRecipe.setupCommands ?? []),
          ...environmentVersion.recipe.setupCommands,
        ],
        resources: { ...environmentVersion.recipe.resources },
      }
    : baseRecipe;
  const recipeDigest = environmentVersion?.digest
    ?? createHash('sha256').update(JSON.stringify(recipe)).digest('hex');
  let defaultProvisionFailure: string | undefined;
  if (transport && typeof (transport as { provision?: unknown }).provision === 'function') {
    const result = await (transport as unknown as { provision(recipe: { workspaceId: string }): Promise<{ status: 'ok' | 'error'; error?: string; metadata?: Record<string, unknown> }> }).provision(recipe);
    // B3: persist provisioning logs (workspace_ensure / setup_command#N / skipped
    // repo+artifact placeholders) emitted by hand-server so audit can correlate.
    await appendProvisioningLogs({
      eventStore: params.eventStore,
      sessionId: params.sessionId,
      handId: defaultHandId,
      workspaceId: params.workspaceId,
      metadata: result.metadata,
    });
    if (result.status === 'error') {
      defaultProvisionFailure = result.error ?? 'hand provision failed';
      await params.eventStore.append({
        type: 'hand_failure',
        sessionId: params.sessionId,
        workspaceId: params.workspaceId,
        error: defaultProvisionFailure,
        classifiedAs: 'unhealthy',
      });
    }
  }
  await manager.provision({
    handId: defaultHandId,
    sessionId: params.sessionId,
    workspaceId: params.workspaceId,
    type: params.executionTarget,
    status: defaultProvisionFailure ? 'unhealthy' : 'ready',
    endpoint: params.endpoint,
    capabilities,
    recipe,
    providerId: params.executionTarget,
    ...(environmentVersion ? { templateVersionId: environmentVersion.versionId } : {}),
    ...(params.runId ? { runId: params.runId } : {}),
    recipeDigest,
    // 2026-08-03 P1：per-session hand 记录挂租约。register 是 upsert，活跃
    // session 每次 dispatch 自动续期；到期由 janitor 收敛（见 handStore.sweepLeases）。
    ...(params.executionTarget === 'server-remote'
      ? { leaseExpiresAt: new Date(Date.now() + SERVER_REMOTE_HAND_LEASE_MS) }
      : {}),
    metadata: { registeredBy: 'rawRuntimeRunDispatch' },
  });
  if (params.environmentStore && environmentVersion && params.userTenantId) {
    const version = environmentVersion;
    const leaseExpiresAt = new Date(Date.now() + SERVER_REMOTE_HAND_LEASE_MS).toISOString();
    const current = currentEnvironmentInstance;
    if (current) {
      await params.environmentStore.upsert({
        tenantId: params.userTenantId,
        instanceId: defaultHandId,
        providerId: params.executionTarget,
        templateId: version.templateId,
        templateVersionId: version.versionId,
        handId: defaultHandId,
        status: defaultProvisionFailure ? 'unhealthy' : 'ready',
        leaseExpiresAt,
        recipeDigest,
        expectedRevision: current.revision,
      });
    } else {
      const created = await params.environmentStore.create({
        tenantId: params.userTenantId,
        instanceId: defaultHandId,
        providerId: params.executionTarget,
        templateId: version.templateId,
        templateVersionId: version.versionId,
        handId: defaultHandId,
        leaseExpiresAt,
        recipeDigest,
      });
      await params.environmentStore.transition({
        tenantId: params.userTenantId,
        instanceId: created.instanceId,
        status: defaultProvisionFailure ? 'unhealthy' : 'ready',
        expectedRevision: created.revision,
      });
    }
  }
  if (defaultProvisionFailure) {
    throw new Error(`HAND_PROVISION_FAILED:${defaultProvisionFailure}`);
  }

  for (const hand of selectTenantRemoteHandsForRegistration(params.tenantRemoteHands, {
    userId: params.userId,
    username: params.username,
    userTenantId: params.userTenantId,
  })) {
    const remoteWorkspaceId = params.workspaceId;
    const handId = `${params.sessionId}:${hand.id}`;

    let status: 'provisioning' | 'unhealthy' = 'provisioning';
    let failure: string | undefined;
    let resolvedToken: string | undefined;
    let tokenRef: string | undefined;
    let tokenSource: 'inline' | 'vault' | 'unresolved' = 'unresolved';

    try {
      const resolved = await params.tenantRemoteHandResolver!.resolveForRegister(hand);
      resolvedToken = resolved.authToken;
      tokenRef = resolved.authTokenRef;
      tokenSource = resolved.source;
    } catch (err) {
      status = 'unhealthy';
      failure = `vault_resolve_failed: ${err instanceof Error ? err.message : String(err)}`;
      await params.eventStore.append({
        type: 'hand_failure',
        sessionId: params.sessionId,
        workspaceId: remoteWorkspaceId,
        handId,
        error: failure,
        classifiedAs: 'unhealthy',
      });
    }

    if (!resolvedToken && !failure) {
      status = 'unhealthy';
      failure = 'tenant remote hand auth token was not resolved';
      await params.eventStore.append({
        type: 'hand_failure',
        sessionId: params.sessionId,
        workspaceId: remoteWorkspaceId,
        handId,
        error: failure,
        classifiedAs: 'auth',
      });
    }

    const tenantRecipe = buildWorkspaceRecipe(remoteWorkspaceId, hand.recipe, params.sessionId, params.workspaceMountSubPath);
    const tenantRecipeDigest = createHash('sha256').update(JSON.stringify(tenantRecipe)).digest('hex');
    await manager.provision({
      handId,
      sessionId: params.sessionId,
      workspaceId: remoteWorkspaceId,
      type: 'server-remote',
      status,
      endpoint: hand.baseUrl,
      capabilities: tenantRemoteHandCapabilities(hand, tools),
      recipe: tenantRecipe,
      providerId: hand.id,
      ...(params.runId ? { runId: params.runId } : {}),
      recipeDigest: tenantRecipeDigest,
      // 2026-08-03 P1：tenant hand 的 per-session 记录同样挂租约（配置本体在
      // config/vault，不受影响；到期只回收这条 session 级记录）。
      leaseExpiresAt: new Date(Date.now() + SERVER_REMOTE_HAND_LEASE_MS),
      metadata: {
        registeredBy: 'tenantRemoteHands',
        tenantRemoteHandId: hand.id,
        tenantRemoteHandTokenSource: tokenSource,
        ...(tokenRef ? { authTokenRef: tokenRef } : {}),
        ...(hand.invokeTimeoutMs ? { invokeTimeoutMs: hand.invokeTimeoutMs } : {}),
        ...(hand.networkPolicy ? { networkPolicy: hand.networkPolicy } : {}),
        ...(failure ? { provisionFailure: failure } : {}),
      },
    });

    if (resolvedToken) {
      const tenantTransport = new HttpTransport({
        baseUrl: hand.baseUrl,
        authToken: resolvedToken,
        invokeTimeoutMs: hand.invokeTimeoutMs,
      });
      void provisionTenantRemoteHand({
        handStore: params.handStore,
        eventStore: params.eventStore,
        transport: tenantTransport,
        recipe: tenantRecipe,
        sessionId: params.sessionId,
        handId,
        workspaceId: remoteWorkspaceId,
        logger: params.logger,
      });
    }

    if (tokenSource !== 'unresolved') {
      params.logger?.info(
        `tenant_hand_registered handId=${handId} source=${tokenSource}${tokenRef ? ` authTokenRef=${tokenRef}` : ''}`,
      );
    }
  }
}

function workspaceCapability(description: string, tools: ToolDescriptor[], constraints: string[]): HandCapability {
  return {
    name: 'workspace',
    description,
    tools,
    constraints,
    risk: tools.some((tool) => tool.risk === 'dangerous')
      ? 'dangerous'
      : tools.some((tool) => tool.risk === 'workspace_write')
        ? 'workspace_write'
        : 'safe',
  };
}

function tenantRemoteHandCapabilities(
  hand: TenantRemoteHandDispatchConfig,
  tools: ToolDescriptor[],
): HandCapability[] {
  const capabilities: HandCapability[] = [workspaceCapability(
    hand.description ?? `Tenant Agent hand appliance (${hand.id})`,
    tools,
    [
      'tenant Agent hand appliance',
      'workspace.root is never serialized to the remote hand',
      'platform EventStore/RunStore remains the source of truth',
    ],
  )];

  if (hand.id === 'agent-saas-acs') {
    capabilities.push(
      {
        name: 'browser',
        description: 'Browser automation and web page rendering are available in the ACS production Agent hand.',
        tools: [],
        constraints: ['Chromium/Playwright runtime is provided by the sandbox image'],
        risk: 'workspace_write',
      },
      {
        name: 'media',
        description: 'Media processing tools are available in the ACS production Agent hand.',
        tools: [],
        constraints: ['ffmpeg/ffprobe are provided by the sandbox image; ImageMagick is extension-only'],
        risk: 'workspace_write',
      },
      {
        name: 'document-conversion',
        description: 'Office, PDF, OCR, and document conversion tools are available in the ACS production Agent hand.',
        tools: [],
        constraints: ['Minimal LibreOffice, Poppler, QPDF, Ghostscript, Tesseract and CJK fonts are provided by the sandbox image; Pandoc is extension-only'],
        risk: 'workspace_write',
      },
    );
  }

  return capabilities;
}

/**
 * B3: Persist provisioning step logs returned by hand-server `/provision` (in
 * the response body, surfaced as `metadata.logs`). Each entry becomes a single
 * `hand_provisioning_log` event. Returns silently when logs are absent or
 * malformed — provisioning still succeeds when the brain can't parse the body.
 */
async function appendProvisioningLogs(args: {
  eventStore: EventStore;
  sessionId: string;
  handId: string;
  workspaceId: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const logs = args.metadata?.logs;
  if (!Array.isArray(logs)) return;
  for (const raw of logs) {
    if (!raw || typeof raw !== 'object') continue;
    const log = raw as Record<string, unknown>;
    const step = typeof log.step === 'string' ? log.step : undefined;
    const status = log.status === 'ok' || log.status === 'error' || log.status === 'skipped'
      ? log.status
      : undefined;
    if (!step || !status) continue;
    await args.eventStore.append({
      type: 'hand_provisioning_log',
      sessionId: args.sessionId,
      handId: args.handId,
      workspaceId: args.workspaceId,
      step,
      status,
      ...(typeof log.command === 'string' ? { command: log.command } : {}),
      ...(typeof log.stdout === 'string' ? { stdout: log.stdout } : {}),
      ...(typeof log.stderr === 'string' ? { stderr: log.stderr } : {}),
      ...(typeof log.exitCode === 'number' ? { exitCode: log.exitCode } : {}),
      ...(typeof log.durationMs === 'number' ? { durationMs: log.durationMs } : {}),
      ...(typeof log.note === 'string' ? { note: log.note } : {}),
    }).catch(() => undefined);
  }
}

async function provisionTenantRemoteHand(args: {
  handStore?: HandStore;
  eventStore: EventStore;
  transport: HttpTransport;
  recipe: WorkspaceRecipe;
  sessionId: string;
  handId: string;
  workspaceId: string;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}): Promise<void> {
  try {
    const result = await args.transport.provision(args.recipe);
    await appendProvisioningLogs({
      eventStore: args.eventStore,
      sessionId: args.sessionId,
      handId: args.handId,
      workspaceId: args.workspaceId,
      metadata: result.metadata,
    });

    if (result.status === 'error') {
      const error = result.error ?? 'tenant remote hand provision failed';
      await args.handStore?.updateStatus(args.handId, 'unhealthy', {
        provisionFailure: error,
        lastProvisionedAt: new Date().toISOString(),
      });
      await args.eventStore.append({
        type: 'hand_failure',
        sessionId: args.sessionId,
        workspaceId: args.workspaceId,
        handId: args.handId,
        error,
        classifiedAs: 'unhealthy',
      });
      await args.eventStore.append({
        type: 'hand_health_changed',
        sessionId: args.sessionId,
        workspaceId: args.workspaceId,
        handId: args.handId,
        status: 'unhealthy',
        detail: error,
      });
      return;
    }

    await args.handStore?.updateStatus(args.handId, 'ready', {
      provisionFailure: null,
      lastProvisionedAt: new Date().toISOString(),
      ...(result.metadata ? { lastProvisionMetadata: result.metadata } : {}),
    });
    await args.eventStore.append({
      type: 'hand_health_changed',
      sessionId: args.sessionId,
      workspaceId: args.workspaceId,
      handId: args.handId,
      status: 'ready',
      detail: 'provisioned',
    });
    args.logger?.info(`tenant_hand_ready handId=${args.handId}`);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await args.handStore?.updateStatus(args.handId, 'unhealthy', {
      provisionFailure: error,
      lastProvisionedAt: new Date().toISOString(),
    }).catch(() => undefined);
    await args.eventStore.append({
      type: 'hand_failure',
      sessionId: args.sessionId,
      workspaceId: args.workspaceId,
      handId: args.handId,
      error,
      classifiedAs: 'unknown',
    }).catch(() => undefined);
    await args.eventStore.append({
      type: 'hand_health_changed',
      sessionId: args.sessionId,
      workspaceId: args.workspaceId,
      handId: args.handId,
      status: 'unhealthy',
      detail: error,
    }).catch(() => undefined);
    args.logger?.warn(`tenant_hand_provision_failed handId=${args.handId}: ${error}`);
  }
}
