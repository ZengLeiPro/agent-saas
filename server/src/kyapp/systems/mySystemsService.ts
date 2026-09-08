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
      (item) => allowed.has(item.installationId) && ['enabled', 'disabled'].includes(item.status),
    );
    const resolved = await Promise.all(candidates.map((item) => this.resolve(item)));
    return resolved.filter((item): item is MyBusinessSystem => item !== null);
  }

  private async resolve(installation: KyAppInstallation): Promise<MyBusinessSystem | null> {
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
      personalAuthorizationStatus: 'not_required',
      canOpenPage: status.pageStatus === 'available',
      canUseAgent: status.agentStatus === 'ready',
    };
  }
}
