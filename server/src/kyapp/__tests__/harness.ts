import type { PgEntitlementStore } from '../../data/entitlements/store.js';
/**
 * WP2a 单测装配台：用内存 store 拼出与生产同构的一整套 kyapp 服务，
 * 再挂上真实的 express router，让端点 × 鉴权矩阵、发布门禁、投递与探测都能在无 PG 环境跑通。
 *
 * 只有「存储」和「出站 fetch」是替身；配置解析、SAT 签发、门禁判定、状态机、
 * 路由与鉴权全部是生产代码本身。
 */
import express, { type Express, type Request } from 'express';

import { InMemorySecretVault } from '../../security/secretVault.js';
import type { JwtPayload } from '../../auth/types.js';
import type { PgAssignmentStore } from '../../data/assignments/store.js';
import type { GovernanceAuditStore } from '../../data/governance-audit/types.js';
import { InMemoryKyAppNonceStore } from '../attest/nonceStore.js';
import { KyAppHandshakeService } from '../attest/handshake.js';
import { resolveKyAppConfig, type KyAppPlatformConfig } from '../config.js';
import { KyAppEventDispatcher } from '../events/dispatcher.js';
import { KyAppHealthProber } from '../health/prober.js';
import { KyAppCredentialManager } from '../installations/credentials.js';
import { KyAppInstallationService } from '../installations/service.js';
import type { PgKyAppCredentialStore } from '../installations/credentialStore.js';
import type { KyAppInstallationDirectory } from '../installations/queries.js';
import type { PgKyAppInstallationRuntimeStore } from '../installations/runtimeStore.js';
import { KyAppSigningKeyService } from '../keys/service.js';
import type { PgKyAppSigningKeyStore } from '../keys/store.js';
import { createKyAppOutbound, type KyAppOutbound } from '../outbound.js';
import { MemoryDirectorySnapshotSource } from '../directory/snapshot.js';
import { createKyAppDirectoryRouter } from '../routes/directory.js';
import { createKyAppHandshakeRouter } from '../routes/handshake.js';
import { createKyAppInstallationsRouter } from '../routes/installations.js';
import { createKyAppJwksHandler, createKyAppKeysRouter } from '../routes/keys.js';
import { createKyAppMineRouter } from '../routes/mine.js';
import { createKyAppShellEventsRouter } from '../routes/shellEvents.js';
import { createKyAppSystemsRouter } from '../routes/systems.js';
import { KyAppSatIssuer } from '../sat/issuer.js';
import { KyAppSuspensionRegistry } from '../sat/suspension.js';
import type { PgKyAppSystemStore } from '../systems/store.js';
import type { PgKyAppOutboundEventStore } from '../events/store.js';
import type { KyAppToolRegistrationDryRun } from '../systems/publishGate.js';
import { FakeSigningKeyStore } from './signingKeyStoreDouble.js';
import { MemoryDirectoryChangeLog } from './directoryDoubles.js';
import {
  MemoryKyAppCredentialStore,
  MemoryKyAppDirectory,
  MemoryKyAppOutboundEventStore,
  MemoryKyAppRuntimeStore,
  MemoryKyAppSystemStore,
} from './memoryStores.js';

export const TEST_TENANT = 't_demo';
export const TEST_SYSTEM = 'demo-erp';
export const TEST_IID = 'tsi_demo_01';
export const TEST_ORIGIN = 'https://erp.apps.kaiyancn.com';
export const PLATFORM_TENANT = 'pantheon';

export const PLATFORM_ADMIN: JwtPayload = {
  sub: 'u_platform',
  username: 'platform',
  role: 'admin',
  tenantId: PLATFORM_TENANT,
  authEpoch: 1,
  generation: 1,
  jti: 'sess-platform',
};
export const ORG_ADMIN: JwtPayload = {
  sub: 'u_org_admin',
  username: 'orgadmin',
  role: 'admin',
  tenantId: TEST_TENANT,
  authEpoch: 1,
  generation: 1,
  jti: 'sess-org-admin',
};
export const MEMBER: JwtPayload = {
  sub: 'u_member',
  username: 'member',
  role: 'user',
  tenantId: TEST_TENANT,
  authEpoch: 1,
  generation: 1,
  jti: 'sess-member',
};
export const OTHER_TENANT_ADMIN: JwtPayload = {
  sub: 'u_other',
  username: 'other',
  role: 'admin',
  tenantId: 't_other',
  authEpoch: 1,
  generation: 1,
  jti: 'sess-other',
};

/** 最小可过 `validateManifest` 的 manifest；用 override 制造语义 diff。 */
export function buildManifest(override: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: 1,
    systemId: TEST_SYSTEM,
    name: '演示 ERP',
    description: '演示用系统',
    roles: { adminRole: 'erp_admin' },
    pathPrefixes: { user: ['/api/app/'], admin: ['/api/admin/'] },
    capabilities: [
      {
        id: 'order.search',
        name: '查订单',
        description: '按条件查询订单列表，返回订单号与金额；用户询问订单进度时使用。',
        riskLevel: 'read_only',
        approval: 'none',
        safeToRetry: true,
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['keyword'],
          properties: {
            keyword: { type: 'string', maxLength: 40 },
            limit: { type: 'integer', minimum: 1, maximum: 20 },
            channel: { type: 'string', enum: ['web', 'app'] },
          },
        },
        outputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { orderId: { type: 'string' } },
        },
      },
    ],
    ...override,
  };
}

/** 内存 SecretVault 的调用凭证由服务自带；这里只暴露实例供断言。 */
export interface KyAppTestRig {
  app: Express;
  config: KyAppPlatformConfig;
  vault: InMemorySecretVault;
  systems: MemoryKyAppSystemStore;
  credentialStore: MemoryKyAppCredentialStore;
  runtimeStore: MemoryKyAppRuntimeStore;
  eventStore: MemoryKyAppOutboundEventStore;
  nonces: InMemoryKyAppNonceStore;
  signingKeys: FakeSigningKeyStore;
  keys: KyAppSigningKeyService;
  issuer: KyAppSatIssuer;
  credentials: KyAppCredentialManager;
  installations: KyAppInstallationService;
  handshake: KyAppHandshakeService;
  dispatcher: KyAppEventDispatcher;
  prober: KyAppHealthProber;
  outbound: KyAppOutbound;
  /** WP2b：快照分页数据源与变更日志的内存替身（路由与消费端都是生产代码）。 */
  directorySnapshots: MemoryDirectorySnapshotSource;
  directoryChanges: MemoryDirectoryChangeLog;
  audit: GovernanceAuditStore;
  auditEvents: Array<Record<string, unknown>>;
  alerts: Array<{ kind: string; installationId: string }>;
  /** 切换当前请求身份；`null` 表示匿名。 */
  setUser(user: JwtPayload | null): void;
  request(path: string, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

export interface KyAppTestRigOptions {
  entitlements?: PgEntitlementStore;
  assignmentStore?: PgAssignmentStore;
  fetchImpl?: typeof fetch;
  resolveTxt?: (hostname: string) => Promise<string[][]>;
  toolRegistrationDryRun?: KyAppToolRegistrationDryRun;
  now?: () => number;
  /** 组织成员表；缺省让所有用户都是本组织的 active 成员。 */
  getMembership?: (
    tenantId: string,
    userId: string,
  ) => Promise<{ persona: 'member' | 'org_admin'; status: 'active' | 'disabled' } | null>;
  /** `listEffectiveResourceIds` 的返回；缺省放行全部 enabled 实例。 */
  visibleInstallationIds?: string[];
  /** WP2b 快照页大小；缺省 2，逼出分页。 */
  directoryPageSize?: number;
}

function memoryAudit(sink: Array<Record<string, unknown>>): GovernanceAuditStore {
  let sequence = 0;
  return {
    async append(event: Record<string, unknown>) {
      sequence += 1;
      const stored = { ...event, auditId: `audit-${sequence}` };
      sink.push(stored);
      return stored as never;
    },
  } as unknown as GovernanceAuditStore;
}

export async function createKyAppTestRig(options: KyAppTestRigOptions = {}): Promise<KyAppTestRig> {
  const config = resolveKyAppConfig({
    kyApp: { environment: 'prod', probe: { failureThreshold: 5 } },
  }) as KyAppPlatformConfig;
  const now = options.now ?? Date.now;

  const vault = new InMemorySecretVault();
  const systems = new MemoryKyAppSystemStore();
  const credentialStore = new MemoryKyAppCredentialStore();
  const runtimeStore = new MemoryKyAppRuntimeStore();
  const eventStore = new MemoryKyAppOutboundEventStore();
  const nonces = new InMemoryKyAppNonceStore();
  const signingKeys = new FakeSigningKeyStore(now);
  const directory = new MemoryKyAppDirectory(systems);
  const directorySnapshots = new MemoryDirectorySnapshotSource();
  const directoryChanges = new MemoryDirectoryChangeLog();
  const auditEvents: Array<Record<string, unknown>> = [];
  const audit = memoryAudit(auditEvents);
  const alerts: Array<{ kind: string; installationId: string }> = [];

  const keys = new KyAppSigningKeyService({
    store: signingKeys as unknown as PgKyAppSigningKeyStore,
    vault,
    now,
  });
  const suspensions = new KyAppSuspensionRegistry({ now });
  const issuer = new KyAppSatIssuer({
    config,
    keys,
    suspensions,
    now,
    guard: {
      async getUser() {
        return { disabled: false };
      },
      async getMembership() {
        return { status: 'active' };
      },
      getInstallation: (installationId) => systems.getInstallation(installationId),
      validatesAuthEpoch: () => true,
    },
  });
  const credentials = new KyAppCredentialManager({
    store: credentialStore as unknown as PgKyAppCredentialStore,
    vault,
    now,
  });
  const outbound = createKyAppOutbound({
    config,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    // 测试域名不做真实 DNS 解析：本机 DNS 可能把未注册域名劫持到保留网段，
    // 那样 `validateRemoteUrl` 会先于业务逻辑拒绝，掩盖真正要验的行为。
    lookup: (async () => [{ address: '93.184.216.34', family: 4 }]) as never,
  });
  const assignments = options.assignmentStore ?? {
    async getAssignmentSet() {
      return null;
    },
    async replaceAssignments() {
      return { version: 1 };
    },
    async listEffectiveResourceIds() {
      const ids =
        options.visibleInstallationIds ??
        (await systems.listEnabled()).map((item) => item.installationId);
      return ids.map((resourceId) => ({ resourceId }));
    },
  } as unknown as PgAssignmentStore;

  const installations = new KyAppInstallationService({
    config,
    systems: systems as unknown as PgKyAppSystemStore,
    events: eventStore as unknown as PgKyAppOutboundEventStore,
    audit,
    assignments,
    now,
    memberships: {
      async getMembership(tenantId, userId) {
        const membership = await options.getMembership?.(tenantId, userId);
        if (options.getMembership) return membership ? { status: membership.status } : null;
        return { status: 'active' };
      },
    },
    ...(options.resolveTxt ? { resolveTxt: options.resolveTxt } : {}),
  });
  const handshake = new KyAppHandshakeService({
    config,
    systems: systems as unknown as PgKyAppSystemStore,
    nonces,
    credentials,
    issuer,
    now,
  });
  const dispatcher = new KyAppEventDispatcher({
    config,
    store: eventStore as unknown as PgKyAppOutboundEventStore,
    systems: systems as unknown as PgKyAppSystemStore,
    directory: directory as unknown as KyAppInstallationDirectory,
    keys,
    issuer,
    outbound,
    now,
    onAbandoned: (alert) =>
      alerts.push({ kind: 'abandoned', installationId: alert.installationId }),
  });
  const prober = new KyAppHealthProber({
    config,
    directory: directory as unknown as KyAppInstallationDirectory,
    runtimeStore: runtimeStore as unknown as PgKyAppInstallationRuntimeStore,
    issuer,
    outbound,
    now,
    clearAlert: (installationId) => runtimeStore.clearAlert(installationId),
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
    onAlert: (alert) => alerts.push({ kind: alert.kind, installationId: alert.installationId }),
  });

  let currentUser: JwtPayload | null = PLATFORM_ADMIN;
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res, next) => {
    if (currentUser) req.user = currentUser;
    next();
  });
  app.use(
    '/api/app-contract/v1',
    createKyAppSystemsRouter({
      ...(options.entitlements ? { entitlements: options.entitlements } : {}),
      systems: systems as unknown as PgKyAppSystemStore,
      audit,
      ...(options.toolRegistrationDryRun
        ? { toolRegistrationDryRun: options.toolRegistrationDryRun }
        : {}),
    }),
  );
  app.use(
    '/api/app-contract/v1',
    createKyAppInstallationsRouter({
      audit,
      ...(options.entitlements ? { entitlements: options.entitlements } : {}),
      systems: systems as unknown as PgKyAppSystemStore,
      installations,
      credentials,
      runtimeStore: runtimeStore as unknown as PgKyAppInstallationRuntimeStore,
    }),
  );
  app.use(
    '/api/app-contract/v1',
    createKyAppHandshakeRouter({
      handshake,
      isTenantAdmin: async (user) => user.role === 'admin',
    }),
  );
  app.use('/api/app-contract/v1', createKyAppKeysRouter({ keys, dispatcher, audit }));
  app.use('/api/app-contract/v1', createKyAppShellEventsRouter({ audit }));
  app.use(
    '/api/app-contract/v1',
    createKyAppDirectoryRouter({
      credentials,
      getInstallation: (installationId) => systems.getInstallation(installationId),
      snapshots: directorySnapshots,
      changes: directoryChanges,
      now,
      // 页大小调到 2，保证一致性测试一定会分页（与 mockShell/directory.ts 默认值同口径）。
      pageSize: options.directoryPageSize ?? 2,
    }),
  );
  app.use(
    '/api',
    createKyAppMineRouter({
      systems: systems as unknown as PgKyAppSystemStore,
      assignments,
      runtimeStore: runtimeStore as unknown as PgKyAppInstallationRuntimeStore,
    }),
  );
  app.get(config.jwksPath, createKyAppJwksHandler(keys));

  // 生产由 `assembly.start()` 保证 active 密钥存在；测试里显式做同一件事。
  await keys.ensureActive();

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;

  return {
    app,
    config,
    vault,
    systems,
    credentialStore,
    runtimeStore,
    eventStore,
    nonces,
    signingKeys,
    keys,
    issuer,
    credentials,
    installations,
    handshake,
    dispatcher,
    prober,
    outbound,
    directorySnapshots,
    directoryChanges,
    audit,
    auditEvents,
    alerts,
    setUser(user) {
      currentUser = user;
    },
    request: (path, init) => fetch(`${base}${path}`, init),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 便捷：JSON 请求体。 */
export function json(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

/** 把一个系统推到 published 并建好一个 enabled 安装实例。 */
export async function seedPublishedInstallation(rig: KyAppTestRig): Promise<{ digest: string }> {
  const registered = await rig.systems.registerVersion({
    systemId: TEST_SYSTEM,
    name: '演示 ERP',
    manifest: buildManifest(),
    actor: 'u_seed',
  });
  await rig.systems.publishVersion({
    systemId: TEST_SYSTEM,
    digest: registered.version.digest,
    expectedVersion: registered.definition.version,
    actor: 'u_seed',
  });
  await rig.systems.createInstallation({
    installationId: TEST_IID,
    tenantId: TEST_TENANT,
    systemId: TEST_SYSTEM,
    baseUrl: TEST_ORIGIN,
    origin: TEST_ORIGIN,
    techContactUserId: 'u_tech',
    actor: 'u_seed',
  });
  await rig.systems.updateInstallationStatus({
    installationId: TEST_IID,
    status: 'enabled',
    actor: 'u_seed',
  });
  return { digest: registered.version.digest };
}
