import type { PgAssignmentStore } from '../../data/assignments/store.js';
import type {
  KyAppInstallationRuntimeRecord,
  PgKyAppInstallationRuntimeStore,
} from '../installations/runtimeStore.js';
import type {
  KyAppInstallation,
  KyAppInstallationStatus,
  KyAppSystemDefinition,
  KyAppSystemStatus,
} from './types.js';
import type { PgKyAppSystemStore } from './store.js';
import type { UserCapabilityObservationReader } from '../gateway/capabilityObservationStore.js';
import type {
  KyAppMineState,
  MyBusinessSystem,
  MySystemAgentStatus,
  MySystemNextAction,
  MySystemPageStatus,
} from './mySystemsTypes.js';

export const DEFAULT_MINE_FAILURE_THRESHOLD = 5;

export interface MySystemsServiceOptions {
  systems: Pick<PgKyAppSystemStore, 'listInstallationsForTenant' | 'getDefinition' | 'getVersion'>;
  assignments?: Pick<PgAssignmentStore, 'listEffectiveResourceIds'> & {
    listVisibleInstallationIds?: (
      tenantId: string,
      userId: string,
    ) => ReturnType<PgAssignmentStore['listEffectiveResourceIds']>;
  };
  runtimeStore?: Pick<PgKyAppInstallationRuntimeStore, 'get'>;
  capabilityObservations?: Pick<UserCapabilityObservationReader, 'get'>;
  failureThreshold?: number;
}

export function parseExternalLinkHosts(manifest: unknown): string[] {
  const raw = (manifest as { externalLinkHosts?: unknown } | null)?.externalLinkHosts;
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

export function resolveMineState(input: {
  installationStatus: KyAppInstallationStatus;
  definitionStatus: KyAppSystemStatus;
  registeredDigest: string | null;
  runtime: KyAppInstallationRuntimeRecord | null;
  failureThreshold: number;
}): KyAppMineState {
  if (input.installationStatus === 'pending') return 'pending';
  if (input.installationStatus !== 'enabled' || input.definitionStatus !== 'published') {
    return 'disabled';
  }
  const runtime = input.runtime;
  if (!runtime) return 'enabled';
  if (runtime.liveStatus === 'maintenance') return 'maintenance';
  if (runtime.liveStatus === 'failed' && runtime.consecutiveFailures >= input.failureThreshold) {
    return 'unavailable';
  }
  if (
    runtime.readyStatus === 'ok' &&
    runtime.manifestDigest !== null &&
    input.registeredDigest !== null &&
    runtime.manifestDigest !== input.registeredDigest
  ) {
    return 'needs_reregistration';
  }
  return 'enabled';
}

function deriveStatus(input: {
  installation: KyAppInstallation;
  definition: KyAppSystemDefinition;
  runtime: KyAppInstallationRuntimeRecord | null;
  failureThreshold: number;
}): {
  pageStatus: MySystemPageStatus;
  agentStatus: MySystemAgentStatus;
  reasonCode: string | null;
  nextAction: MySystemNextAction;
  message: string;
} {
  const { installation, definition, runtime, failureThreshold } = input;
  if (installation.status === 'pending') {
    const domainVerified = installation.domainVerifiedAt !== null;
    return {
      pageStatus: 'not_configured',
      agentStatus: domainVerified ? 'waiting_service' : 'not_configured',
      reasonCode: domainVerified ? 'ready_required' : 'domain_verification_required',
      nextAction: 'continue_onboarding',
      message: domainVerified
        ? '业务系统正在接入，请继续完成服务就绪检查'
        : '业务系统正在接入，请继续验证业务域名',
    };
  }
  if (installation.status !== 'enabled' || definition.status !== 'published') {
    return {
      pageStatus: 'unavailable',
      agentStatus: 'disabled',
      reasonCode: 'installation_disabled',
      nextAction: 'none',
      message: '业务系统已停用，页面和 Agent 能力暂不可用',
    };
  }
  if (runtime?.liveStatus === 'failed' && runtime.consecutiveFailures >= failureThreshold) {
    return {
      pageStatus: 'unavailable',
      agentStatus: 'degraded',
      reasonCode: 'service_unavailable',
      nextAction: 'retry',
      message: '业务服务暂时无法连接，请稍后重试或联系技术联系人',
    };
  }
  if (runtime?.liveStatus === 'maintenance') {
    return {
      pageStatus: 'unavailable',
      agentStatus: 'degraded',
      reasonCode: 'service_maintenance',
      nextAction: 'retry',
      message: '业务系统正在更新，页面和 Agent 能力暂不可用',
    };
  }
  if (!installation.registeredDigest) {
    return {
      pageStatus: 'available',
      agentStatus: 'waiting_service',
      reasonCode: 'ready_required',
      nextAction: 'continue_onboarding',
      message: '页面已经开通，Agent 能力正在等待业务服务就绪',
    };
  }
  if (!runtime || runtime.readyStatus !== 'ok' || runtime.liveStatus !== 'ok') {
    const degraded = runtime?.readyStatus === 'failed';
    return {
      pageStatus: 'available',
      agentStatus: degraded ? 'degraded' : 'waiting_service',
      reasonCode: degraded ? 'diagnostic_failed' : 'ready_required',
      nextAction: 'retry',
      message: degraded
        ? '页面已经开通，Agent 能力接入检查未通过'
        : '页面已经开通，Agent 能力正在等待业务服务就绪',
    };
  }
  if (runtime.manifestDigest !== installation.registeredDigest) {
    return {
      pageStatus: 'available',
      agentStatus: 'waiting_service',
      reasonCode: 'manifest_digest_mismatch',
      nextAction: 'continue_onboarding',
      message: '页面已经开通，Agent 能力正在等待版本确认',
    };
  }
  return {
    pageStatus: 'available',
    agentStatus: 'ready',
    reasonCode: null,
    nextAction: 'none',
    message: '页面和 Agent 能力均可使用',
  };
}

export class MySystemsService {
  private readonly failureThreshold: number;

  constructor(private readonly options: MySystemsServiceOptions) {
    this.failureThreshold = options.failureThreshold ?? DEFAULT_MINE_FAILURE_THRESHOLD;
  }

  async listForUser(tenantId: string, userId: string): Promise<MyBusinessSystem[]> {
    if (!this.options.assignments) return [];
    const installations = await this.options.systems.listInstallationsForTenant(tenantId);
    if (installations.length === 0) return [];
    const effective = this.options.assignments.listVisibleInstallationIds
      ? await this.options.assignments.listVisibleInstallationIds(tenantId, userId)
      : await this.options.assignments.listEffectiveResourceIds(
          tenantId,
          userId,
          'system_installation',
        );
    const allowed = new Set(effective.map((item) => item.resourceId));
    const candidates = installations.filter(
      (item) => allowed.has(item.installationId) && item.status !== 'deleted',
    );
    const resolved = await Promise.all(candidates.map((item) => this.resolve(item, userId)));
    return resolved.filter((item): item is MyBusinessSystem => item !== null);
  }

  private async resolve(
    installation: KyAppInstallation,
    userId: string,
  ): Promise<MyBusinessSystem | null> {
    const definition = await this.options.systems.getDefinition(installation.systemId);
    if (!definition?.publishedDigest) return null;
    const digest = installation.registeredDigest ?? definition.publishedDigest;
    const [version, runtime] = await Promise.all([
      this.options.systems.getVersion(installation.systemId, digest),
      installation.status === 'enabled'
        ? (this.options.runtimeStore?.get(installation.installationId) ?? Promise.resolve(null))
        : Promise.resolve(null),
    ]);
    const manifest = (version?.manifest ?? {}) as { name?: unknown; icon?: unknown };
    const status = deriveStatus({
      installation,
      definition,
      runtime,
      failureThreshold: this.failureThreshold,
    });
    const capability = await this.resolveCapabilityStatus(installation, userId, status);
    return {
      installationId: installation.installationId,
      systemId: installation.systemId,
      name: typeof manifest.name === 'string' ? manifest.name : definition.name,
      icon: typeof manifest.icon === 'string' ? manifest.icon : null,
      origin: installation.origin,
      state: resolveMineState({
        installationStatus: installation.status,
        definitionStatus: definition.status,
        // 兼容旧壳 state：页面可访问性在尚未 CAS 时仍以已发布版本判断；
        // Agent 三维状态继续使用真实 registeredDigest，保持能力 fail-closed。
        registeredDigest: digest,
        runtime,
        failureThreshold: this.failureThreshold,
      }),
      externalLinkHosts: parseExternalLinkHosts(version?.manifest),
      ...status,
      ...capability,
      canOpenPage: status.pageStatus === 'available',
      canUseAgent: capability.agentStatus === 'ready',
    };
  }

  private async resolveCapabilityStatus(
    installation: KyAppInstallation,
    userId: string,
    technical: ReturnType<typeof deriveStatus>,
  ): Promise<Pick<
    MyBusinessSystem,
    'agentStatus' | 'personalAuthorizationStatus' | 'reasonCode' | 'nextAction' | 'message'
  >> {
    if (technical.agentStatus !== 'ready' || !installation.registeredDigest) {
      return {
        ...technical,
        personalAuthorizationStatus:
          installation.status === 'enabled' ? 'pending' : 'not_required',
      };
    }
    const observation = await this.options.capabilityObservations?.get(
      installation.tenantId,
      installation.installationId,
      userId,
    );
    if (!observation || observation.registeredDigest !== installation.registeredDigest) {
      return {
        agentStatus: 'waiting_personal_authorization',
        personalAuthorizationStatus: 'pending',
        reasonCode: 'me_not_verified',
        nextAction: 'retry',
        message: '页面已经开通，请新建对话确认当前账号的业务能力',
      };
    }
    if (observation.status === 'unavailable') {
      return {
        agentStatus: 'degraded',
        personalAuthorizationStatus: 'pending',
        reasonCode: 'me_unavailable',
        nextAction: 'retry',
        message: '页面已经开通，但暂时无法确认当前账号的业务能力',
      };
    }
    if (observation.status === 'capacity_limited') {
      return {
        agentStatus: 'degraded',
        personalAuthorizationStatus: 'connected',
        reasonCode: 'tool_projection_limit',
        nextAction: 'retry',
        message: '当前账号已获授权，但会话工具数量达到上限，暂未注入该业务系统能力',
      };
    }
    if (observation.status === 'insufficient_scope' || observation.enabledCapabilityCount === 0) {
      return {
        agentStatus: 'waiting_personal_authorization',
        personalAuthorizationStatus: 'insufficient_scope',
        reasonCode: 'me_no_enabled_capabilities',
        nextAction: 'authorize',
        message: '页面已经开通，当前账号尚未获得可用的业务能力',
      };
    }
    return {
      agentStatus: 'ready',
      personalAuthorizationStatus: 'connected',
      reasonCode: null,
      nextAction: 'none',
      message: '页面和 Agent 能力均可使用',
    };
  }
}
