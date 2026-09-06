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
import type { AppRuntime } from './../app/runtime.js';
import type { KyAppPlatformConfig } from './config.js';
import { PgKyAppNonceStore } from './attest/nonceStore.js';
import { KyAppHandshakeService } from './attest/handshake.js';
import { PgKyAppDirectoryChangeLog } from './directory/changeLog.js';
import { DirectoryProjector, GovernanceDirectorySource } from './directory/projection.js';
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
import { KyAppSatIssuer } from './sat/issuer.js';
import { KyAppSuspensionRegistry } from './sat/suspension.js';
import { PgKyAppSystemStore } from './systems/store.js';
import { KyAppWorker, createKyAppAlertSink, shouldRunKyAppWorker } from './worker.js';

export interface KyAppAssembly {
  config: KyAppPlatformConfig;
  systems: PgKyAppSystemStore;
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
  outbound: KyAppOutbound;
  worker: KyAppWorker;
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
    now,
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
  });

  // 让 `runtimeAssignmentResourceResolver` 的 system_installation 分支拿到真实 store。
  (runtime as { kyAppSystemStore?: PgKyAppSystemStore }).kyAppSystemStore = systems;
  // 登出 / 撤销 / 禁用后立即停签 user SAT（§3.1 残留风险）。
  runtime.authEpochAuthority?.onAudit?.(suspensions.onAuthEpochAudit);

  return {
    config,
    systems,
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
    outbound,
    worker,
    async start() {
      // 全部 store 共用同一套 governance 迁移（含 WP2b 的 v42 目录两表）；
      // 跑一次即可，其余靠 IF NOT EXISTS 幂等。
      await systems.init();
      await keys.ensureActive();
      if (shouldRunKyAppWorker(runtime.processRole)) worker.start();
    },
    stop() {
      worker.stop();
    },
  };
}
