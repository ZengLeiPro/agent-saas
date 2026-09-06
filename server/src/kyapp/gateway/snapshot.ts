/**
 * WP3：会话工具快照（规范 §6.1；WP3 施工总则 §3.2）。
 *
 * 快照键 `(sessionId, installationId, registeredDigest)`：
 * - 会话**首个 run** 创建，后续 run（含审批恢复 / 交互恢复 / 后台任务）只读；
 * - 能力集 = 登记 manifest ∩ `/ky/v1/me` 的 `capabilities[].enabled`；
 * - 失效**仅**三种：新会话、`installation.*` 事件、`registeredDigest` 变化。
 *   菜单刷新、能力开关翻动都不影响当前会话（提示「能力已更新，将在新会话生效」）。
 * - fail-static：`/me` 或安装目录读取失败时**保留上次快照**；
 *   会话首个 run 就失败则本会话无 `app__` 工具并标记 `degraded`。
 *   **任何情况下都不中途静默删工具**——工具面一抖，`prompt_cache_key` 就废。
 */
import { toolName as buildAppToolName } from '@kaiyan/ky-app-contract';

import type { Manifest, ManifestCapability, ResultLink, RiskLevel } from '@kaiyan/ky-app-contract';

import type { KyAppGatewayConfig } from '../config.js';
import type { AppToolSnapshotStore } from './snapshotStore.js';

/** 快照里的一条能力（工具投影与后续调用所需的全部事实）。 */
export interface AppCapabilityEntry {
  installationId: string;
  systemId: string;
  /** manifest `name`，客户面「系统名」。 */
  systemName: string;
  capabilityId: string;
  /** `app__<systemId>__<capabilityId>`，由契约包 `toolName()` 生成。 */
  toolName: string;
  capabilityName: string;
  description: string;
  riskLevel: RiskLevel;
  safeToRetry: boolean;
  inputSchema: Record<string, unknown>;
  /** §4.3：单次调用超时上限（≤ 15,000，出站层再与实例级 15 s 取小）。 */
  timeoutMs?: number;
  /** §5.2：结果链接模板。Gateway 在 `envelope.ts` 里替换占位后放进 `meta.resultLink`。 */
  resultLink?: ResultLink;
  /** 调用时随 SAT 带出的 `dig`。 */
  registeredDigest: string;
  baseUrl: string;
}

/** 冻结在会话上的工具面。 */
export interface AppToolSnapshot {
  sessionId: string;
  tenantId: string;
  userId: string;
  /** `installationId:registeredDigest` 排序后 join，用于判定是否需要重建。 */
  key: string;
  entries: readonly AppCapabilityEntry[];
  /** 会话首个 run 就没能拿到 `/me`（或安装目录）→ 本会话无 `app__` 工具，需提示。 */
  degraded: boolean;
  createdAt: number;
}

/** 快照构建所需的安装实例视图（与 `/api/systems/mine` 的可见性口径一致）。 */
export interface AppVisibleInstallation {
  installationId: string;
  systemId: string;
  baseUrl: string;
  registeredDigest: string;
}

/**
 * 快照的事实来源。三个方法都可能失败；失败语义由各自返回类型表达，
 * **不要抛异常来表示「暂时不可用」**（会被 fail-static 逻辑当成 bug）。
 */
export interface AppSnapshotSource {
  /** 本租户内该用户可见且 `enabled`、系统已发布、`registeredDigest` 非空的安装实例。 */
  listVisibleInstallations(input: {
    tenantId: string;
    userId: string;
  }): Promise<AppVisibleInstallation[]>;
  /** 读登记 digest 对应的 manifest；读不到 → `null`（digest fail-closed，跳过该实例）。 */
  readManifest(input: { systemId: string; digest: string }): Promise<Manifest | null>;
  /** `/ky/v1/me` 的 `capabilities[].enabled`；不可用 → `null`（触发 fail-static）。 */
  readEnabledCapabilities(input: {
    installation: AppVisibleInstallation;
    tenantId: string;
    userId: string;
  }): Promise<Set<string> | null>;
}

export interface AppToolSnapshotServiceOptions {
  source: AppSnapshotSource;
  config: Pick<KyAppGatewayConfig, 'enabled' | 'maxToolsPerSession'>;
  /**
   * 跨进程持久化（总控 2026-09-06 拍板，偏差 3-A-05 → 3-B-01）。
   * 缺省 = 只有进程内 Map（单进程测试用）。生产必须注入，否则
   * 审批恢复（Web 进程）与后台任务（runtime worker 进程）会各建一份快照，
   * 工具面漂移 → `prompt_cache_key` 失配。
   */
  store?: AppToolSnapshotStore;
  /** 缓存的会话数上限，防长跑进程无界增长。 */
  maxSessions?: number;
  now?: () => number;
  logger?: { warn(message: string): void };
}

const DEFAULT_MAX_SESSIONS = 2_000;

function computeKey(installations: readonly AppVisibleInstallation[]): string {
  return installations
    .map((item) => `${item.installationId}:${item.registeredDigest}`)
    .sort()
    .join('|');
}

function readCapabilities(manifest: Manifest): readonly ManifestCapability[] {
  const capabilities = (manifest as { capabilities?: unknown }).capabilities;
  return Array.isArray(capabilities) ? (capabilities as ManifestCapability[]) : [];
}

function readSystemName(manifest: Manifest, systemId: string): string {
  const name = (manifest as { name?: unknown }).name;
  return typeof name === 'string' && name.trim() ? name.trim() : systemId;
}

export class AppToolSnapshotService {
  private readonly snapshots = new Map<string, AppToolSnapshot>();

  private readonly now: () => number;

  private readonly maxSessions: number;

  constructor(private readonly options: AppToolSnapshotServiceOptions) {
    this.now = options.now ?? Date.now;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  }

  /**
   * 取本会话的工具面。首个 run 建快照，后续 run 只在
   * `registeredDigest` 组合变化时重建；其余一律返回既有快照。
   */
  async get(input: {
    sessionId: string;
    tenantId: string;
    userId: string;
  }): Promise<AppToolSnapshot> {
    const cached = this.snapshots.get(input.sessionId);
    if (!this.options.config.enabled) {
      return cached ?? this.emptySnapshot(input, '', false);
    }

    let installations: AppVisibleInstallation[];
    try {
      installations = await this.options.source.listVisibleInstallations({
        tenantId: input.tenantId,
        userId: input.userId,
      });
    } catch (error) {
      // fail-static：目录不可用时保留上次快照；首个 run 就失败则本会话为空。
      this.options.logger?.warn(
        `[ky-app-gateway] 安装目录读取失败，沿用既有工具快照：${error instanceof Error ? error.message : String(error)}`,
      );
      return cached ?? this.remember(this.emptySnapshot(input, '', true));
    }

    const key = computeKey(installations);
    if (cached && cached.key === key) return cached;

    // 跨进程：本进程没有（或 key 不符），先看别的进程有没有为这个会话冻结过同一份工具面。
    const persisted = await this.loadPersisted(input, key);
    if (persisted) return this.remember(persisted);

    const built = await this.build(input, installations, key, cached);
    return this.remember(await this.persist(built));
  }

  /**
   * 新会话之外的两个失效入口之一：`installation.*` 事件。
   * 进程内同步清；落库那份异步删（失败只记日志——下一次 digest 比对会兜住，
   * 因为 `registeredDigest` 变化本身就会让 key 不匹配而重建）。
   */
  invalidateInstallation(installationId: string): void {
    for (const [sessionId, snapshot] of this.snapshots) {
      if (snapshot.entries.some((entry) => entry.installationId === installationId)) {
        this.snapshots.delete(sessionId);
      }
    }
    void this.options.store?.deleteByInstallation(installationId).catch((error: unknown) => {
      this.options.logger?.warn(
        `[ky-app-gateway] 快照失效（installation ${installationId}）落库删除失败：${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  /** 会话结束/删除时的显式清理（不属于规范的失效条件，只是回收内存）。 */
  forgetSession(sessionId: string): void {
    this.snapshots.delete(sessionId);
  }

  /**
   * 读落库快照。**只有 key 完全相同才认**：key 变了说明 `registeredDigest` 组合变了，
   * 按 §6.1 本来就该重建。租户/用户不符一律不认（防会话 id 复用带来的越权）。
   */
  private async loadPersisted(
    input: { sessionId: string; tenantId: string; userId: string },
    key: string,
  ): Promise<AppToolSnapshot | null> {
    const store = this.options.store;
    if (!store) return null;
    try {
      const row = await store.load(input.sessionId);
      if (!row || row.key !== key) return null;
      if (row.tenantId !== input.tenantId || row.userId !== input.userId) return null;
      return {
        sessionId: row.sessionId,
        tenantId: row.tenantId,
        userId: row.userId,
        key: row.key,
        entries: row.entries,
        degraded: row.degraded,
        createdAt: row.createdAt,
      };
    } catch (error) {
      // 落库不可用不能拖垮 run：退回进程内语义（本进程自建一份）。
      this.options.logger?.warn(
        `[ky-app-gateway] 读取会话工具快照失败 ${input.sessionId}：${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * 写落库快照，返回**最终生效**的那一份 —— 并发时首个写入者获胜，
   * 后到者拿回先到者那一份，两个进程收敛到逐字节相同的工具面。
   */
  private async persist(snapshot: AppToolSnapshot): Promise<AppToolSnapshot> {
    const store = this.options.store;
    if (!store) return snapshot;
    try {
      const saved = await store.save({
        sessionId: snapshot.sessionId,
        tenantId: snapshot.tenantId,
        userId: snapshot.userId,
        key: snapshot.key,
        entries: [...snapshot.entries],
        degraded: snapshot.degraded,
        createdAt: snapshot.createdAt,
      });
      return { ...snapshot, entries: saved.entries, degraded: saved.degraded, key: saved.key };
    } catch (error) {
      this.options.logger?.warn(
        `[ky-app-gateway] 写入会话工具快照失败 ${snapshot.sessionId}：${error instanceof Error ? error.message : String(error)}`,
      );
      return snapshot;
    }
  }

  /** 只读视图，供测试与诊断。 */
  peek(sessionId: string): AppToolSnapshot | undefined {
    return this.snapshots.get(sessionId);
  }

  private emptySnapshot(
    input: { sessionId: string; tenantId: string; userId: string },
    key: string,
    degraded: boolean,
  ): AppToolSnapshot {
    return { ...input, key, entries: [], degraded, createdAt: this.now() };
  }

  private remember(snapshot: AppToolSnapshot): AppToolSnapshot {
    if (!this.snapshots.has(snapshot.sessionId) && this.snapshots.size >= this.maxSessions) {
      const oldest = this.snapshots.keys().next();
      if (!oldest.done) this.snapshots.delete(oldest.value);
    }
    this.snapshots.set(snapshot.sessionId, snapshot);
    return snapshot;
  }

  private async build(
    input: { sessionId: string; tenantId: string; userId: string },
    installations: readonly AppVisibleInstallation[],
    key: string,
    previous: AppToolSnapshot | undefined,
  ): Promise<AppToolSnapshot> {
    const entries: AppCapabilityEntry[] = [];
    let degraded = false;

    for (const installation of installations) {
      const manifest = await this.readManifestSafely(installation);
      // digest fail-closed：登记 digest 读不到 manifest 就整实例不投影。
      if (!manifest) continue;

      const systemName = readSystemName(manifest, installation.systemId);
      const enabled = await this.readEnabledSafely(installation, input);
      if (enabled === null) {
        // fail-static：沿用上次快照里属于这个实例的能力集合，但**用新 manifest 重建**条目 ——
        // 只保留能力 id，schema 与 registeredDigest 一律取当前值，避免带着过期 dig 去调用。
        // 上次快照里没有的能力不会凭空出现；首个 run 就失败 → 本会话该实例无工具。
        const carriedIds = new Set(
          (previous?.entries ?? [])
            .filter((entry) => entry.installationId === installation.installationId)
            .map((entry) => entry.capabilityId),
        );
        if (carriedIds.size === 0) {
          degraded = true;
          continue;
        }
        for (const capability of readCapabilities(manifest)) {
          if (!carriedIds.has(capability.id)) continue;
          const entry = this.toEntry(installation, systemName, capability);
          if (entry) entries.push(entry);
        }
        continue;
      }

      for (const capability of readCapabilities(manifest)) {
        if (!enabled.has(capability.id)) continue;
        const entry = this.toEntry(installation, systemName, capability);
        if (entry) entries.push(entry);
      }
    }

    // 逐字节稳定的排序：同一 (sessionId, digests) 组合每次都得到同一序列。
    entries.sort((left, right) => left.toolName.localeCompare(right.toolName));
    const limit = this.options.config.maxToolsPerSession;
    if (entries.length > limit) {
      this.options.logger?.warn(
        `[ky-app-gateway] 会话 ${input.sessionId} 的 app__ 工具数 ${entries.length} 超过上限 ${limit}，按工具名字典序截断`,
      );
      entries.length = limit;
    }
    return { ...input, key, entries, degraded, createdAt: this.now() };
  }

  private toEntry(
    installation: AppVisibleInstallation,
    systemName: string,
    capability: ManifestCapability,
  ): AppCapabilityEntry | null {
    let name: string;
    try {
      // 工具名一律走契约包，禁止自己拼（§4.5 长度与规范化都在里面）。
      name = buildAppToolName(installation.systemId, capability.id);
    } catch (error) {
      this.options.logger?.warn(
        `[ky-app-gateway] 能力 ${installation.systemId}/${capability.id} 工具名非法，已跳过：${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
    return {
      installationId: installation.installationId,
      systemId: installation.systemId,
      systemName,
      capabilityId: capability.id,
      toolName: name,
      capabilityName: capability.name,
      description: capability.description,
      riskLevel: capability.riskLevel,
      safeToRetry: capability.safeToRetry,
      inputSchema: capability.inputSchema as Record<string, unknown>,
      ...(capability.timeoutMs === undefined ? {} : { timeoutMs: capability.timeoutMs }),
      ...(capability.resultLink ? { resultLink: capability.resultLink } : {}),
      registeredDigest: installation.registeredDigest,
      baseUrl: installation.baseUrl,
    };
  }

  private async readManifestSafely(installation: AppVisibleInstallation): Promise<Manifest | null> {
    try {
      return await this.options.source.readManifest({
        systemId: installation.systemId,
        digest: installation.registeredDigest,
      });
    } catch (error) {
      this.options.logger?.warn(
        `[ky-app-gateway] 读取 manifest 失败 ${installation.systemId}@${installation.registeredDigest}：${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async readEnabledSafely(
    installation: AppVisibleInstallation,
    input: { tenantId: string; userId: string },
  ): Promise<Set<string> | null> {
    try {
      return await this.options.source.readEnabledCapabilities({
        installation,
        tenantId: input.tenantId,
        userId: input.userId,
      });
    } catch (error) {
      this.options.logger?.warn(
        `[ky-app-gateway] /me 读取失败 ${installation.installationId}：${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}
