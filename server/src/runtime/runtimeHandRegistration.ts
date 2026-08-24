import { createHash, randomUUID } from 'crypto';

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
import {
  assertRuntimeIsolationEvidence,
  integrationRuntimeIsolationRequirement,
  type RuntimeIsolationEvidence,
  type RuntimeIsolationRequirement,
} from './runtimeIsolationEvidence.js';
export { integrationRuntimeIsolationRequirement };

/**
 * Sandbox 归属键。决定「哪些执行流共享同一个 ACS Sandbox pod」。
 *
 * - 不传 `topLevelSessionId`：退回 workspace 级共享（2026-08-10 之前的行为）。
 *   这是**故意保留的安全 fallback**——任何拿不到顶层会话的旧路径/异常路径都落回
 *   旧语义，绝不允许因缺参而滑向「每次调用一个孤儿 pod」。
 * - 传了：顶层会话组独享 pod（per-session Sandbox，A 方案）。子 Agent / 孙 Agent /
 *   后台任务通过继承父 `WorkspaceRef.topLevelSessionId` 落到同一个 scope，因此
 *   「父 + 其全部后代」始终同 pod（决策 7）。
 *
 * 决策 7 的现行依据（2026-08-10 双 pod 实测后更换，旧「负缓存」理由已作废）：
 *   ① 跨 pod 时文件属性（size/mtime）最长 600s 不刷新，实测 120s 仍旧值，
 *      而 `lookupcache=positive` 只能修目录项缓存、修不了属性缓存；父子链恰是
 *      最容易触发增量构建（tsc --incremental / vitest 缓存）误判的组合。
 *   ② 同 pod 共享内核页缓存，后代读父读过的文件是热的。
 *   ③ pod 数 = 顶层会话组数而非会话数，避免 fan-out 打爆 SNAT 条目上限。
 *
 * scope 值无长度上限：k8s label 存 sha256 前 40 位，CR 名走 hash16 + 截断前缀
 * （见 acs-orchestrator/src/sandboxName.ts），故可安全拼接 UUID。
 */
export function deriveSandboxScopeId(input: {
  workspaceId: string;
  mountSubPath?: string;
  topLevelSessionId?: string;
}): string {
  const base = input.mountSubPath
    ? `${input.workspaceId}__${input.mountSubPath.replace(/[^A-Za-z0-9_-]+/g, '_')}`
    : input.workspaceId;
  if (!input.topLevelSessionId) return base;
  return `${base}__s_${input.topLevelSessionId.replace(/[^A-Za-z0-9_-]+/g, '_')}`;
}

function buildWorkspaceRecipe(
  workspaceId: string,
  override?: Partial<WorkspaceRecipe>,
  sessionId?: string,
  mountSubPath?: string,
  topLevelSessionId?: string,
): WorkspaceRecipe {
  const effectiveMountSubPath = override?.mountSubPath ?? mountSubPath;
  return {
    ...(override ?? {}),
    workspaceId,
    sandboxScopeId: override?.sandboxScopeId
      ?? deriveSandboxScopeId({ workspaceId, mountSubPath: effectiveMountSubPath, topLevelSessionId }),
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
  /**
   * 顶层会话 ID（per-session Sandbox 的归属键）。顶层会话传自己的 sessionId；
   * 子 Agent / 后台任务传**递归到顶层**的那个 ID，从而与父会话落在同一 pod（决策 7）。
   * 缺省时 `deriveSandboxScopeId` 退回 workspace 级共享，是安全 fallback。
   */
  topLevelSessionId?: string;
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
  /** Authoritative tenant from the persisted runtime session/run boundary. */
  tenantId?: string;
  /** Server-derived Integration Work/Review identity; never accepted from clients. */
  runtimeIsolationRequirement?: RuntimeIsolationRequirement;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}): Promise<void> {
  if (!params.handStore) {
    if (params.runtimeIsolationRequirement) throw new Error('RUNTIME_ISOLATION_EVIDENCE_MISSING:handStore');
    return;
  }
  const persistedTenantId = params.tenantId?.trim();
  const resolvedUserTenantId = params.userTenantId?.trim();
  if (persistedTenantId && resolvedUserTenantId && persistedTenantId !== resolvedUserTenantId) {
    throw new Error(`Runtime hand tenant mismatch for session ${params.sessionId}`);
  }
  const eventTenantId = persistedTenantId ?? resolvedUserTenantId;
  if (!eventTenantId) throw new Error(`Runtime hand tenant is missing for session ${params.sessionId}`);
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
    tenantId: eventTenantId,
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
    params.topLevelSessionId,
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
  if (params.runtimeIsolationRequirement) {
    if (params.executionTarget !== 'server-remote') {
      throw new Error('RUNTIME_ISOLATION_EVIDENCE_MISSING:executionTarget');
    }
    recipe.runtimeIsolationRequirement = params.runtimeIsolationRequirement;
  }
  const recipeDigest = environmentVersion?.digest
    ?? createHash('sha256').update(JSON.stringify(recipe)).digest('hex');
  const defaultHandRegistration = {
    handId: defaultHandId,
    sessionId: params.sessionId,
    workspaceId: params.workspaceId,
    type: params.executionTarget,
    endpoint: params.endpoint,
    capabilities,
    recipe,
    providerId: params.executionTarget,
    ...(environmentVersion ? { templateVersionId: environmentVersion.versionId } : {}),
    ...(params.runId ? { runId: params.runId } : {}),
    recipeDigest,
    ...(params.executionTarget === 'server-remote'
      ? { leaseExpiresAt: new Date(Date.now() + SERVER_REMOTE_HAND_LEASE_MS) }
      : {}),
  };
  let defaultProvisionAttempted = false;
  let defaultProvisionFailure: string | undefined;
  let defaultProvisionMetadata: Record<string, unknown> | undefined;
  const defaultProvisionGeneration = randomUUID();
  const initialProvisionMetadata = {
    registeredBy: 'rawRuntimeRunDispatch',
    provisionFailure: null,
    provisionRecoveryToken: null,
    provisionRecoveryClaimedAtMs: null,
    provisionGeneration: defaultProvisionGeneration,
    provision: { attempts: 0, lastStatus: 'provisioning', lastAttemptAt: new Date().toISOString() },
  };
  await manager.provision({
    ...defaultHandRegistration,
    status: 'provisioning',
    metadata: initialProvisionMetadata,
  });
  if (transport && typeof (transport as { provision?: unknown }).provision === 'function') {
    defaultProvisionAttempted = true;
    try {
      const result = await (transport as unknown as { provision(recipe: { workspaceId: string }): Promise<{ status: 'ok' | 'error'; error?: string; metadata?: Record<string, unknown> }> }).provision(recipe);
      defaultProvisionMetadata = result.metadata;
      // B3: persist provisioning logs (workspace_ensure / setup_command#N / skipped
      // repo+artifact placeholders) emitted by hand-server so audit can correlate.
      await appendProvisioningLogs({
        eventStore: params.eventStore,
        tenantId: eventTenantId,
        sessionId: params.sessionId,
        handId: defaultHandId,
        workspaceId: params.workspaceId,
        metadata: result.metadata,
      }).catch((err) => {
        params.logger?.warn(`default hand provisioning log append failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      if (result.status === 'error') defaultProvisionFailure = result.error ?? 'hand provision failed';
    } catch (err) {
      defaultProvisionFailure = err instanceof Error ? err.message : String(err);
    }
  }
  let verifiedRuntimeIsolationEvidence: RuntimeIsolationEvidence | undefined;
  if (params.runtimeIsolationRequirement && !defaultProvisionFailure) {
    const provisionMetadata = isRecord(defaultProvisionMetadata?.metadata)
      ? defaultProvisionMetadata.metadata
      : defaultProvisionMetadata;
    const evidence = provisionMetadata?.runtimeIsolationEvidence;
    const verification = {
      requirement: params.runtimeIsolationRequirement,
      evidence,
      sandboxScopeId: recipe.sandboxScopeId ?? recipe.workspaceId,
    };
    try {
      assertRuntimeIsolationEvidence(verification);
      verifiedRuntimeIsolationEvidence = verification.evidence;
    } catch (err) {
      defaultProvisionFailure = err instanceof Error ? err.message : String(err);
    }
  }
  const defaultFinalStatus = defaultProvisionFailure ? 'unhealthy' : 'ready';
  const defaultFinalMetadata = {
    registeredBy: 'rawRuntimeRunDispatch',
    provisionGeneration: defaultProvisionGeneration,
    provisionFailure: defaultProvisionFailure ?? null,
    provisionRecoveryToken: null,
    provisionRecoveryClaimedAtMs: null,
    ...(defaultProvisionAttempted ? {
      provision: {
        attempts: 0,
        lastStatus: defaultProvisionFailure ? 'error' : 'ok',
        lastAttemptAt: new Date().toISOString(),
        ...(defaultProvisionFailure ? { lastError: defaultProvisionFailure } : {}),
      },
    } : {}),
    ...(verifiedRuntimeIsolationEvidence ? {
      runtimeIsolationAttested: true,
      runId: verifiedRuntimeIsolationEvidence.runId,
      policyDigest: verifiedRuntimeIsolationEvidence.policyDigest,
      sandboxName: verifiedRuntimeIsolationEvidence.sandboxName,
      sandboxScopeId: verifiedRuntimeIsolationEvidence.sandboxScopeId,
    } : {}),
  };
  const completedDefaultHand = await params.handStore.completeProvisionAttempt(
    defaultHandId,
    defaultProvisionGeneration,
    defaultFinalStatus,
    defaultFinalMetadata,
  );
  if (!completedDefaultHand) return;
  if (defaultProvisionFailure) {
    try {
      await params.eventStore.append({
        type: 'hand_failure',
        sessionId: params.sessionId,
        workspaceId: params.workspaceId,
        handId: defaultHandId,
        error: defaultProvisionFailure,
        classifiedAs: 'unhealthy',
      }, { tenantId: eventTenantId });
    } catch {
      // Hand 状态落库优先；审计事件故障不得掩盖 provisionFailure。
    }
  }
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

  for (const hand of selectTenantRemoteHandsForRegistration(params.runtimeIsolationRequirement ? [] : params.tenantRemoteHands, {
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
      }, { tenantId: eventTenantId });
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
      }, { tenantId: eventTenantId });
    }

    const tenantRecipe = buildWorkspaceRecipe(
      remoteWorkspaceId,
      hand.recipe,
      params.sessionId,
      params.workspaceMountSubPath,
      params.topLevelSessionId,
    );
    const tenantRecipeDigest = createHash('sha256').update(JSON.stringify(tenantRecipe)).digest('hex');
    const tenantProvisionGeneration = randomUUID();
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
        provisionGeneration: tenantProvisionGeneration,
        provisionFailure: failure ?? null,
        provisionRecoveryToken: null,
        provisionRecoveryClaimedAtMs: null,
        provision: {
          attempts: 0,
          lastStatus: failure ? 'error' : 'provisioning',
          lastAttemptAt: new Date().toISOString(),
          ...(failure ? { lastError: failure } : {}),
        },
        ...(tokenRef ? { authTokenRef: tokenRef } : {}),
        ...(hand.invokeTimeoutMs ? { invokeTimeoutMs: hand.invokeTimeoutMs } : {}),
        ...(hand.networkPolicy ? { networkPolicy: hand.networkPolicy } : {}),
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
        tenantId: eventTenantId,
        transport: tenantTransport,
        recipe: tenantRecipe,
        provisionGeneration: tenantProvisionGeneration,
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
  tenantId: string;
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
    }, { tenantId: args.tenantId }).catch(() => undefined);
  }
}

async function provisionTenantRemoteHand(args: {
  handStore: HandStore;
  eventStore: EventStore;
  tenantId: string;
  transport: HttpTransport;
  recipe: WorkspaceRecipe;
  provisionGeneration: string;
  sessionId: string;
  handId: string;
  workspaceId: string;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void };
}): Promise<void> {
  const complete = async (status: 'ready' | 'unhealthy', metadata: Record<string, unknown>) => {
    return await args.handStore.completeProvisionAttempt(
      args.handId,
      args.provisionGeneration,
      status,
      metadata,
    );
  };
  try {
    const result = await args.transport.provision(args.recipe);
    await appendProvisioningLogs({
      eventStore: args.eventStore,
      tenantId: args.tenantId,
      sessionId: args.sessionId,
      handId: args.handId,
      workspaceId: args.workspaceId,
      metadata: result.metadata,
    });

    if (result.status === 'error') {
      const error = result.error ?? 'tenant remote hand provision failed';
      const completed = await complete('unhealthy', {
        provisionFailure: error,
        provisionRecoveryToken: null,
        provisionRecoveryClaimedAtMs: null,
        provision: {
          attempts: 0,
          lastStatus: 'error',
          lastAttemptAt: new Date().toISOString(),
          lastError: error,
        },
        lastProvisionedAt: new Date().toISOString(),
      });
      if (!completed) return;
      await args.eventStore.append({
        type: 'hand_failure',
        sessionId: args.sessionId,
        workspaceId: args.workspaceId,
        handId: args.handId,
        error,
        classifiedAs: 'unhealthy',
      }, { tenantId: args.tenantId });
      await args.eventStore.append({
        type: 'hand_health_changed',
        sessionId: args.sessionId,
        workspaceId: args.workspaceId,
        handId: args.handId,
        status: 'unhealthy',
        detail: error,
      }, { tenantId: args.tenantId });
      return;
    }

    const completed = await complete('ready', {
      provisionFailure: null,
      provisionRecoveryToken: null,
      provisionRecoveryClaimedAtMs: null,
      provision: {
        attempts: 0,
        lastStatus: 'ok',
        lastAttemptAt: new Date().toISOString(),
        lastSucceededAt: new Date().toISOString(),
      },
      lastProvisionedAt: new Date().toISOString(),
      ...(result.metadata ? { lastProvisionMetadata: result.metadata } : {}),
    });
    if (!completed) return;
    await args.eventStore.append({
      type: 'hand_health_changed',
      sessionId: args.sessionId,
      workspaceId: args.workspaceId,
      handId: args.handId,
      status: 'ready',
      detail: 'provisioned',
    }, { tenantId: args.tenantId });
    args.logger?.info(`tenant_hand_ready handId=${args.handId}`);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const completed = await complete('unhealthy', {
      provisionFailure: error,
      provisionRecoveryToken: null,
      provisionRecoveryClaimedAtMs: null,
      provision: {
        attempts: 0,
        lastStatus: 'error',
        lastAttemptAt: new Date().toISOString(),
        lastError: error,
      },
      lastProvisionedAt: new Date().toISOString(),
    }).catch(() => undefined);
    if (!completed) return;
    await args.eventStore.append({
      type: 'hand_failure',
      sessionId: args.sessionId,
      workspaceId: args.workspaceId,
      handId: args.handId,
      error,
      classifiedAs: 'unknown',
    }, { tenantId: args.tenantId }).catch(() => undefined);
    await args.eventStore.append({
      type: 'hand_health_changed',
      sessionId: args.sessionId,
      workspaceId: args.workspaceId,
      handId: args.handId,
      status: 'unhealthy',
      detail: error,
    }, { tenantId: args.tenantId }).catch(() => undefined);
    args.logger?.warn(`tenant_hand_provision_failed handId=${args.handId}: ${error}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
