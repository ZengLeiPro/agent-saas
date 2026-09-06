/**
 * WP3：会话工具快照的生产实现（规范 §6.1、§4.2）。
 *
 * 三件事：
 * 1. 可见安装实例 —— 与 `GET /api/systems/mine`（`routes/mine.ts`）**同一口径**：
 *    本组织 + 实例 `enabled` + `resource_assignments` 命中 + 系统定义已发布；
 *    `assignments` 不可用即 fail-closed 返回空。额外要求 `registeredDigest` 非空
 *    （digest 双重 fail-closed：没登记 digest 就不产生工具）。
 * 2. 登记 manifest —— 按 `registeredDigest` 取版本行，**不回落 publishedDigest**。
 * 3. `/ky/v1/me` 的 `capabilities[].enabled` —— 用 `act=user` SAT 出站直取。
 *    任何失败（签发被拒 / 出站失败 / 非 200 / 结构不对）都返回 `null`，
 *    交给 `AppToolSnapshotService` 做 fail-static，绝不当成「能力全关」。
 */
import { randomUUID } from 'node:crypto';

import type { Manifest } from '@kaiyan/ky-app-contract';

import type { PgAssignmentStore } from '../../data/assignments/store.js';
import type { KyAppPlatformConfig } from '../config.js';
import type { KyAppOutbound } from '../outbound.js';
import { KyAppSatDeniedError, type KyAppPathPrefixes, type KyAppSatIssuer } from '../sat/issuer.js';
import type {
  KyAppInstallation,
  KyAppSystemDefinition,
  KyAppSystemVersion,
} from '../systems/types.js';
import type { AppSnapshotSource, AppVisibleInstallation } from './snapshot.js';

/** §4.2 端点路径。 */
const ME_PATH = '/ky/v1/me';

/** 快照只依赖系统目录的四个读方法，避免把 PG 实现类型拉进来。 */
export interface KyAppSnapshotSystemReader {
  listInstallationsForTenant(tenantId: string): Promise<KyAppInstallation[]>;
  getDefinition(systemId: string): Promise<KyAppSystemDefinition | null>;
  getVersion(systemId: string, digest: string): Promise<KyAppSystemVersion | null>;
}

export interface KyAppSnapshotSourceOptions {
  systems: KyAppSnapshotSystemReader;
  /** 缺失 → fail-closed，不投影任何工具（与 `/api/systems/mine` 一致）。 */
  assignments?: Pick<PgAssignmentStore, 'listEffectiveResourceIds'>;
  issuer: Pick<KyAppSatIssuer, 'issue'>;
  outbound: KyAppOutbound;
  config: Pick<KyAppPlatformConfig, 'gateway'>;
  /** SAT `tadm`：当前用户是否本组织管理员。 */
  isTenantAdmin(input: { tenantId: string; userId: string }): Promise<boolean>;
  /**
   * `act=user` SAT 需要会话 epoch 绑定，而 runtime dispatch 手上没有会话 JWT。
   * 这里由装配方按 `AuthEpochAuthority.current(userId)` 派生 —— 语义是
   * 「该用户至少有一个仍然有效的登录」，与壳侧签发同源，不构成提权。
   */
  resolveAuthBinding(userId: string): { authEpoch?: number; generation?: number } | null;
  logger?: { warn(message: string): void };
  newRequestId?: () => string;
}

function readPathPrefixes(manifest: Record<string, unknown>): KyAppPathPrefixes {
  const raw = manifest.pathPrefixes;
  if (typeof raw !== 'object' || raw === null) return { user: [], admin: [] };
  const value = raw as { user?: unknown; admin?: unknown };
  const pick = (input: unknown): string[] =>
    Array.isArray(input) ? input.filter((item): item is string => typeof item === 'string') : [];
  return { user: pick(value.user), admin: pick(value.admin) };
}

/** 解析 `/me` 的 `capabilities[]`；结构不符返回 `null`（触发 fail-static）。 */
export function parseEnabledCapabilities(payload: unknown): Set<string> | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const capabilities = (payload as { capabilities?: unknown }).capabilities;
  if (!Array.isArray(capabilities)) return null;
  const enabled = new Set<string>();
  for (const item of capabilities) {
    if (typeof item !== 'object' || item === null) return null;
    const { id, enabled: flag } = item as { id?: unknown; enabled?: unknown };
    if (typeof id !== 'string' || typeof flag !== 'boolean') return null;
    if (flag) enabled.add(id);
  }
  return enabled;
}

export function createKyAppSnapshotSource(options: KyAppSnapshotSourceOptions): AppSnapshotSource {
  const newRequestId = options.newRequestId ?? (() => randomUUID());

  async function listVisibleInstallations(input: {
    tenantId: string;
    userId: string;
  }): Promise<AppVisibleInstallation[]> {
    const installations = await options.systems.listInstallationsForTenant(input.tenantId);
    const enabled = installations.filter((item) => item.status === 'enabled');
    if (enabled.length === 0) return [];
    // 分配事实源不可用 → fail-closed（与 `/api/systems/mine` 同一处置）。
    if (!options.assignments) return [];
    const effective = await options.assignments.listEffectiveResourceIds(
      input.tenantId,
      input.userId,
      'system_installation',
    );
    const allowed = new Set(effective.map((item) => item.resourceId));

    const visible: AppVisibleInstallation[] = [];
    for (const installation of enabled) {
      if (!allowed.has(installation.installationId)) continue;
      // digest fail-closed：未完成 CAS 登记的实例不投影任何工具。
      if (!installation.registeredDigest) continue;
      const definition = await options.systems.getDefinition(installation.systemId);
      if (definition?.status !== 'published') continue;
      visible.push({
        installationId: installation.installationId,
        systemId: installation.systemId,
        baseUrl: installation.baseUrl,
        registeredDigest: installation.registeredDigest,
      });
    }
    return visible;
  }

  async function readManifest(input: {
    systemId: string;
    digest: string;
  }): Promise<Manifest | null> {
    const version = await options.systems.getVersion(input.systemId, input.digest);
    return version ? (version.manifest as unknown as Manifest) : null;
  }

  async function readEnabledCapabilities(input: {
    installation: AppVisibleInstallation;
    tenantId: string;
    userId: string;
  }): Promise<Set<string> | null> {
    const { installation } = input;
    const version = await options.systems.getVersion(
      installation.systemId,
      installation.registeredDigest,
    );
    if (!version) return null;

    const tadm = await options.isTenantAdmin({ tenantId: input.tenantId, userId: input.userId });
    let token: string;
    try {
      const sat = await options.issuer.issue({
        act: 'user',
        tenantId: input.tenantId,
        installationId: installation.installationId,
        systemId: installation.systemId,
        userId: input.userId,
        tadm,
        pathPrefixes: readPathPrefixes(version.manifest),
        authBinding: options.resolveAuthBinding(input.userId),
      });
      token = sat.token;
    } catch (error) {
      const reason = error instanceof KyAppSatDeniedError ? error.reason : 'unknown';
      options.logger?.warn(
        `[ky-app-gateway] /me SAT 签发被拒 ${installation.installationId} reason=${reason}`,
      );
      return null;
    }

    const requestId = newRequestId();
    const result = await options.outbound.request({
      baseUrl: installation.baseUrl,
      path: ME_PATH,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, 'X-KY-Request-Id': requestId },
      requestId,
    });
    if (result.status !== 200) {
      options.logger?.warn(
        `[ky-app-gateway] /me 返回 ${result.status} ${installation.installationId} rid=${requestId}`,
      );
      return null;
    }
    const parsed = parseEnabledCapabilities(result.json);
    if (!parsed) {
      options.logger?.warn(
        `[ky-app-gateway] /me 结构不符附录 C ${installation.installationId} rid=${requestId}`,
      );
    }
    return parsed;
  }

  return { listVisibleInstallations, readManifest, readEnabledCapabilities };
}
