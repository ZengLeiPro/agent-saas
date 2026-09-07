import { KyAppAssignmentAccess } from './installations/assignmentAccess.js';
/**
 * WP2a 运行时装配（施工总则 §3.1 / §4 B 行）。
 *
 * `app/runtime.ts` 已在大文件行数棘轮上（3011 行，只许缩不许涨），因此本模块在
 * **路由注册时**按需装配 kyapp 的全部 store 与服务，并把 `kyAppSystemStore` 反写回
 * `AppRuntime`（`runtimeAssignmentResourceResolver` 的 `system_installation` 分支读它）。
 *
 * 前置条件任一不满足即返回 `null`，整套功能关闭（路由不注册、后台循环不启动）：
 * `kyApp` 配置域缺失、治理库不是 PG、SecretVault 未装配。
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import type { AppRuntime } from './../app/runtime.js';
import type { KyAppPlatformConfig } from './config.js';
import { PgKyAppNonceStore } from './attest/nonceStore.js';
import { KyAppHandshakeService } from './attest/handshake.js';
import { PgKyAppDirectoryChangeLog } from './directory/changeLog.js';
import { DirectoryProjector, GovernanceDirectorySource } from './directory/projection.js';
import { PgDirectorySnapshotSource } from './directory/snapshot.js';
import { PgKyAppDeliveryStore } from './delivery/store.js';
import { KyAppDeliveryMetrics } from './delivery/metrics.js';
import { KyAppBalanceMonitor } from './delivery/balanceMonitor.js';
import { KyAppDiagnostics } from './delivery/diagnostics.js';
import { PgKyAppOutboundEventStore } from './events/store.js';
import { KyAppEventDispatcher } from './events/dispatcher.js';
import { KyAppHealthProber } from './health/prober.js';
import { PgKyAppCredentialStore } from './installations/credentialStore.js';
import { PgKyAppInstallationRuntimeStore } from './installations/runtimeStore.js';
import { KyAppCredentialManager } from './installations/credentials.js';
import { KyAppInstallationService } from './installations/service.js';
import {
  KyAppInstallationDirectory,
  clearKyAppInstallationAlert,
} from './installations/queries.js';
import { PgKyAppSigningKeyStore } from './keys/store.js';
import { KyAppSigningKeyService } from './keys/service.js';
import { createKyAppOutbound, type KyAppOutbound } from './outbound.js';
import { AppToolSnapshotService } from './gateway/snapshot.js';
import { createKyAppSnapshotSource } from './gateway/snapshotSource.js';
import { PgAppToolSnapshotStore } from './gateway/snapshotStore.js';
import { AppApprovalRegistry } from './gateway/approval.js';
import { GatewayPolicy } from './gateway/policy.js';
import { AppLogicalCallRunner } from './gateway/lcid.js';
import { createAppCapabilityInvoker } from './gateway/invoker.js';
import { AppCapabilityToolProvider } from './gateway/toolProvider.js';
import { setAppCapabilityGateway, type AppCapabilityGatewayBinding } from './gateway/runtimeBinding.js';
import { KyAppSatIssuer } from './sat/issuer.js';
import { KyAppSuspensionRegistry } from './sat/suspension.js';
import { PgKyAppSystemStore } from './systems/store.js';
import { KyAppWorker, createKyAppAlertSink, shouldRunKyAppWorker } from './worker.js';
import { serverLogger } from '../utils/logger.js';

export interface KyAppAssembly {
  config: KyAppPlatformConfig;
  systems: PgKyAppSystemStore;
  assignmentAccess: KyAppAssignmentAccess | null;
  credentialStore: PgKyAppCredentialStore;
  runtimeStore: PgKyAppInstallationRuntimeStore;
  eventStore: PgKyAppOutboundEventStore;
  nonces: PgKyAppNonceStore;
  keys: KyAppSigningKeyService;
  issuer: KyAppSatIssuer;
  suspensions: KyAppSuspensionRegistry;
  credentials: KyAppCredentialManager;
  installations: KyAppInstallationService;
  handshake: KyAppHandshakeService;
  dispatcher: KyAppEventDispatcher;
  prober: KyAppHealthProber;
  directory: KyAppInstallationDirectory;
  /** WP2b 目录变更日志；`userStore` 未装配时为 `null`（目录整体不启用）。 */
  directoryChangeLog: PgKyAppDirectoryChangeLog | null;
  directoryProjector: DirectoryProjector | null;
  directorySource: GovernanceDirectorySource | null;
  /** WP2b 快照分页的数据源（读投影态表，不建表、不参与迁移）。 */
  directorySnapshots: PgDirectorySnapshotSource | null;
  /** WP5 可恢复交付编排、交付清单与离场计划。 */
  deliveryStore: PgKyAppDeliveryStore;
  deliveryMetrics: KyAppDeliveryMetrics | null;
  diagnostics: KyAppDiagnostics;
  outbound: KyAppOutbound;
  worker: KyAppWorker;
  /** WP3 Capability Gateway：会话工具快照 + `app__` 工具 provider（规范 §6.1）。 */
  gateway: AppCapabilityGatewayBinding;
  /** 建表（幂等，跑 governance 迁移 runner）后再启动后台循环。 */
  start(): Promise<void>;
  stop(): void;
}

export interface BuildKyAppAssemblyOptions {
  runtime: AppRuntime;
  config: KyAppPlatformConfig;
  /** 测试注入：出站 fetch。 */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function buildKyAppAssembly(options: BuildKyAppAssemblyOptions): KyAppAssembly | null {
  const { runtime, config } = options;
  const pool = runtime.runtimePgEventStore?.pool;
  const vault = runtime.secretVault;
  if (!pool || !vault) return null;
  const tablePrefix =
    runtime.config.runtimeEventStore?.backend === 'pg'
      ? runtime.config.runtimeEventStore.tablePrefix
      : undefined;
  const base = { pool, ...(tablePrefix ? { tablePrefix } : {}) };
  const now = options.now ?? Date.now;
  const assignmentAccess = runtime.assignmentStore ? new KyAppAssignmentAccess(pool, runtime.assignmentStore, runtime.directoryGroupStore) : null;

  const systems = new PgKyAppSystemStore(base);
  const credentialStore = new PgKyAppCredentialStore(base);
  const runtimeStore = new PgKyAppInstallationRuntimeStore(base);
  const eventStore = new PgKyAppOutboundEventStore(base);
  const nonces = new PgKyAppNonceStore(base);
  const signingKeyStore = new PgKyAppSigningKeyStore(base);
  const directory = new KyAppInstallationDirectory(pool, systems.installationsTable);

  const keys = new KyAppSigningKeyService({ store: signingKeyStore, vault, now });
  const suspensions = new KyAppSuspensionRegistry({ now });
  const issuer = new KyAppSatIssuer({
    config,
    keys,
    suspensions,
    now,
    guard: {
      async getUser(userId) {
        const record = runtime.userStore?.findById(userId);
        return record ? { disabled: record.disabled === true } : null;
      },
      async getMembership(tenantId, userId) {
        if (!runtime.membershipStore) return { status: 'active' };
        const membership = await runtime.membershipStore.getMembership(tenantId, userId);
        return membership ? { status: membership.status } : null;
      },
      getInstallation: (installationId) => systems.getInstallation(installationId),
      validatesAuthEpoch(userId, binding) {
        // AuthEpochAuthority 未装配时不额外拦截：会话中间件已经是唯一入口。
        return runtime.authEpochAuthority?.validates(userId, binding) ?? true;
      },
    },
  });

  const credentials = new KyAppCredentialManager({ store: credentialStore, vault, now });
  const outbound = createKyAppOutbound({
    config,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const installations = new KyAppInstallationService({
    config,
    systems,
    events: eventStore,
    now,
    // `installation.*` 与 registeredDigest 变化是会话工具快照的两个失效入口（§6.1）。
    onInstallationStateChanged: (installationId) => gateway.snapshots.invalidateInstallation(installationId),
    ...(runtime.governanceAuditStore ? { audit: runtime.governanceAuditStore } : {}),
    ...(runtime.assignmentStore ? { assignments: runtime.assignmentStore } : {}),
    ...(runtime.membershipStore
      ? {
          memberships: {
            getMembership: async (tenantId, userId) => {
              const membership = await runtime.membershipStore!.getMembership(tenantId, userId);
              return membership ? { status: membership.status } : null;
            },
          },
        }
      : {}),
  });
  const handshake = new KyAppHandshakeService({
    config,
    systems,
    nonces,
    credentials,
    issuer,
    canAccessInstallation: async (installation, user) =>
      (await assignmentAccess?.listEffectiveResourceIds(user.tenantId, user.userId, 'system_installation') ?? [])
        .some(item => item.resourceId === installation.installationId),
    now,
    ...(runtime.governanceAuditStore
      ? {
          onSecurityEvent: (event) => {
            void systems
              .getInstallation(event.installationId)
              .then(async (installation) => {
                await runtime.governanceAuditStore!.append({
                  correlationId: `ky-app-attest:${randomUUID()}`,
                  actorType: 'service',
                  actorUserId: '__ky_app_handshake__',
                  actorPersona: 'service',
                  action: `ky_app.${event.kind}`,
                  targetType: 'system_installation',
                  targetId: event.installationId,
                  ...(installation ? { targetTenantId: installation.tenantId } : {}),
                  purpose: 'installation_attestation_security_event',
                  result: 'failed',
                  reason: event.reason,
                  metadata: { userId: event.userId },
                });
              })
              .catch((error) =>
                serverLogger.warn(
                  `[ky-app] 安装证明失败审计写入失败：${error instanceof Error ? error.message : String(error)}`,
                ),
              );
          },
        }
      : {}),
  });

  // WP2b：目录投影的账号事实源是 users.json，`userStore` 缺失就整体不启用，
  // 绝不拿一份空用户表去差分（那会投影出「全组织离职」的删除墓碑）。
  const userStore = runtime.userStore;
  const directoryChangeLog = userStore ? new PgKyAppDirectoryChangeLog(base) : null;
  const directorySource = userStore
    ? new GovernanceDirectorySource({ ...base, users: userStore })
    : null;
  const directoryProjector =
    directoryChangeLog && directorySource
      ? new DirectoryProjector({ ...base, changeLog: directoryChangeLog, source: directorySource })
      : null;
  const directorySnapshots = directoryChangeLog ? new PgDirectorySnapshotSource(base) : null;
  const deliveryStore = new PgKyAppDeliveryStore(pool, tablePrefix);
  const deliveryMetrics =
    runtime.billingService && runtime.userStore && runtime.tenantStore
      ? new KyAppDeliveryMetrics({
          billing: runtime.billingService,
          eventsTable: runtime.runtimePgEventStore!.eventsTable,
          deliveries: deliveryStore,
          users: runtime.userStore,
          tenants: runtime.tenantStore,
          loginLogPath: resolve(runtime.processCwd, './data/login-logs.jsonl'),
        })
      : null;

  const alerts = createKyAppAlertSink(runtime.alertNotifier);
  const dispatcher = new KyAppEventDispatcher({
    config,
    store: eventStore,
    systems,
    directory,
    keys,
    issuer,
    outbound,
    now,
    onAbandoned: alerts.onEventAbandoned,
  });
  const prober = new KyAppHealthProber({
    config,
    directory,
    runtimeStore,
    issuer,
    outbound,
    now,
    clearAlert: (installationId) =>
      clearKyAppInstallationAlert(pool, runtimeStore.table, installationId),
    // §2.5：`ready` 节拍上复验域名归属；只读探测，不改状态机。
    reverifyDomain: async (installationId) => {
      const installation = await systems.getInstallation(installationId);
      if (!installation?.domainVerificationToken) return true;
      const hostname = new URL(installation.baseUrl).hostname;
      const result = await installations.probeDomainOwnership(
        hostname,
        installation.domainVerificationToken,
      );
      return result.verified;
    },
    onAlert: alerts.onHealthAlert,
  });
  const worker = new KyAppWorker({
    dispatcher,
    prober,
    credentials,
    directory,
    keys,
    nonces,
    suspensions,
    alerts,
    directoryIntervalMs: config.directory.reconcileIntervalMs,
    ...(directoryChangeLog && directoryProjector
      ? {
          directoryMaintenance: {
            reconcile: async () => {
              await directoryProjector.reconcileAll();
            },
            purgeExpired: (at: Date) =>
              directoryChangeLog.purgeExpired({
                now: at,
                retentionDays: config.directory.retentionDays,
              }),
          },
        }
      : {}),
    ...(deliveryMetrics
      ? {
          balanceMaintenance: new KyAppBalanceMonitor({
            store: deliveryStore,
            metrics: deliveryMetrics,
            alerts,
          }),
        }
      : {}),
  });

  // WP3 Capability Gateway（规范 §6.1）。`/me` 用 act=user SAT 直取；
  // runtime dispatch 手上没有会话 JWT，authBinding 按 AuthEpochAuthority 当前登录派生。
  const snapshotSource = createKyAppSnapshotSource({
    systems,
    ...(assignmentAccess ? { assignments: assignmentAccess } : {}),
    issuer,
    outbound,
    config,
    logger: { warn: (message) => serverLogger.warn(message) },
    isTenantAdmin: (input) => isTenantAdminForGateway(input),
    resolveAuthBinding: (userId) => {
      const authority = runtime.authEpochAuthority;
      if (!authority) return null;
      const binding = authority.current(userId);
      if (!binding || binding.fenced) return null;
      return { authEpoch: binding.authEpoch, generation: binding.generation };
    },
  });
  // 跨进程快照落库（v43 表）：Web/API 与 runtime worker 必须看到同一份工具面。
  const snapshotStore = new PgAppToolSnapshotStore(base);
  const snapshots = new AppToolSnapshotService({
    source: snapshotSource,
    config: config.gateway,
    store: snapshotStore,
    now,
    logger: { warn: (message) => serverLogger.warn(message) },
  });
  // 逻辑调用状态机 + 四道闸门 + 审批绑定，串成 provider 的 invoke（§6.2）。
  const gatewayPolicy = new GatewayPolicy({ limits: config.gateway.limits, now });
  const gatewayApprovals = new AppApprovalRegistry({ now });
  const isTenantAdminForGateway = async ({ tenantId, userId }: { tenantId: string; userId: string }) => {
    if (!runtime.membershipStore) return false;
    const membership = await runtime.membershipStore.getMembership(tenantId, userId);
    return membership?.status === 'active' && membership.persona === 'org_admin';
  };
  const logicalCalls = new AppLogicalCallRunner({
    issuer,
    outbound,
    config: config.gateway,
    now,
    logger: { warn: (message) => serverLogger.warn(message) },
  });
  const gatewayInvoker = createAppCapabilityInvoker({
    runner: logicalCalls,
    policy: gatewayPolicy,
    approvals: gatewayApprovals,
    config: config.gateway,
    isTenantAdmin: isTenantAdminForGateway,
    logger: { warn: (message) => serverLogger.warn(message) },
    now,
  });
  const gatewayProvider = new AppCapabilityToolProvider({
    snapshots,
    invoker: gatewayInvoker,
    logger: { warn: (message) => serverLogger.warn(message) },
  });
  const gateway: AppCapabilityGatewayBinding = {
    snapshots,
    provider: gatewayProvider,
    approvalTtlMs: config.gateway.approvalTtlMs,
    approvals: gatewayApprovals,
  };
  const diagnostics = new KyAppDiagnostics({
    systems,
    installations,
    credentials,
    issuer,
    outbound,
    logicalCalls,
    audience: config.issuer,
    resolveAuthBinding: (userId) => {
      const binding = runtime.authEpochAuthority?.current(userId);
      if (!binding || binding.fenced) return null;
      return { authEpoch: binding.authEpoch, generation: binding.generation };
    },
    isTenantAdmin: isTenantAdminForGateway,
    now,
  });
  setAppCapabilityGateway(config.gateway.enabled ? gateway : null);

  // 让 `runtimeAssignmentResourceResolver` 的 system_installation 分支拿到真实 store。
  (runtime as { kyAppSystemStore?: PgKyAppSystemStore }).kyAppSystemStore = systems;
  // 登出 / 撤销 / 禁用后立即停签 user SAT（§3.1 残留风险）。
  runtime.authEpochAuthority?.onAudit?.(suspensions.onAuthEpochAudit);

  return {
    config,
    systems,
    assignmentAccess,
    credentialStore,
    runtimeStore,
    eventStore,
    nonces,
    keys,
    issuer,
    suspensions,
    credentials,
    installations,
    handshake,
    dispatcher,
    prober,
    directory,
    directoryChangeLog,
    directoryProjector,
    directorySource,
    directorySnapshots,
    deliveryStore,
    deliveryMetrics,
    outbound,
    worker,
    gateway,
    diagnostics,
    async start() {
      // 全部 store 共用同一套 governance 迁移（含 WP2b 的 v42 目录两表）；
      // 跑一次即可，其余靠 IF NOT EXISTS 幂等。
      await systems.init();
      await keys.ensureActive();
      if (shouldRunKyAppWorker(runtime.processRole)) worker.start();
    },
    stop() {
      worker.stop();
      setAppCapabilityGateway(null);
    },
  };
}
