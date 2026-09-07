/**
 * WP2a `GET /api/systems/mine`（规范 §8.1 最后一条），WP4 Phase B 补丁扩全。
 *
 * 可见性完全由服务端计算：本组织 + `resource_assignments` 命中
 * （支持成员、部门和排除规则）+ 系统定义曾经发布过。
 *
 * **停用的实例也要返回（带状态），不能在服务端就过滤掉。** 规范 §5.5「`live` 失败/停用
 * → 标签保留『暂不可用』」与 §6.6「系统被停用 → 员工看到 标签『暂不可用』」都要求
 * 标签留在侧边栏并显示《系统名》；把实例从列表里删掉，壳侧连名字都拿不到，
 * 只能整项消失 —— 那是规范违反（见基线偏差记录 4-B-04）。
 *
 * 因此本端点返回的是「本人本该看得见的安装实例 + 它此刻的状态」，
 * 壳按 `state` 决定能不能进（`enabled` 才挂 iframe），而不是按「在不在列表里」。
 * 返回值仍只含壳渲染所需的字段，不泄漏 baseUrl / 技术联系人之类的运维信息。
 */
import { Router } from 'express';

import type { PgAssignmentStore } from '../../data/assignments/store.js';
import type {
  KyAppInstallationRuntimeRecord,
  PgKyAppInstallationRuntimeStore,
} from '../installations/runtimeStore.js';
import type { PgKyAppSystemStore } from '../systems/store.js';
import type { KyAppInstallationStatus, KyAppSystemStatus } from '../systems/types.js';
import { sendKyAppError, sendKyAppFailure } from './support.js';

/**
 * 壳可见的实例状态（闭集）。壳按它选 §6.6 的客户面文案：
 * - `enabled` 正常可进；
 * - `disabled` 实例被停用 / 系统已下架 → 标签保留 +「暂不可用」，不给重试；
 * - `unavailable` `live` 连续失败达阈值（§4.6）→ 同上文案，但可重试；
 * - `maintenance` `live` 返回 `maintenance` → 条幅「正在更新，暂不可操作」；
 * - `needs_reregistration` ready 的 `manifestDigest` 与登记 digest 不一致（§6.1 digest fail-closed）→ 同条幅。
 */
export const KY_APP_MINE_STATES = [
  'enabled',
  'disabled',
  'unavailable',
  'maintenance',
  'needs_reregistration',
] as const;
export type KyAppMineState = (typeof KY_APP_MINE_STATES)[number];

/** §4.6 默认阈值；由 `config.probe.failureThreshold` 覆盖。 */
export const DEFAULT_MINE_FAILURE_THRESHOLD = 5;

export interface KyAppMineRoutesOptions {
  systems: PgKyAppSystemStore;
  assignments?: Pick<PgAssignmentStore, 'listEffectiveResourceIds'> & {
    listVisibleInstallationIds?: (tenantId: string, userId: string) => ReturnType<PgAssignmentStore['listEffectiveResourceIds']>;
  };
  /** 运行状态表（§4.6 探测结果）；不注入则只按状态机算 `enabled`/`disabled`。 */
  runtimeStore?: Pick<PgKyAppInstallationRuntimeStore, 'get'>;
  /** `live` 连续失败多少次算「暂不可用」（§4.6，默认 5）。 */
  failureThreshold?: number;
}

export interface KyAppVisibleInstallation {
  installationId: string;
  systemId: string;
  name: string;
  icon: string | null;
  origin: string;
  state: KyAppMineState;
  /** manifest 的 `externalLinkHosts`（§4.5 / §5.4 `link.open` 白名单），默认空数组。 */
  externalLinkHosts: string[];
}

/**
 * manifest 的 `externalLinkHosts` → 归一化 host 白名单。
 * 非数组、非字符串项、空串一律剔除；trim + 小写 + 去重，
 * 让壳侧只做「相等比较」而不必再猜大小写（§5.4 host 精确匹配）。
 */
export function parseExternalLinkHosts(manifest: unknown): string[] {
  const raw = (manifest as { externalLinkHosts?: unknown } | null)?.externalLinkHosts;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const host = item.trim().toLowerCase();
    if (host === '' || out.includes(host)) continue;
    out.push(host);
  }
  return out;
}

/**
 * 状态归一。顺序即优先级：**先看状态机（不可进），再看探测结果（可进但有话说）**。
 * 探测记录缺失时 fail-open 到 `enabled` —— 探测器没跑过不等于系统坏了，
 * 把没探过的实例标成「暂不可用」会在每次冷启动后误伤全部客户。
 */
export function resolveMineState(input: {
  installationStatus: KyAppInstallationStatus;
  definitionStatus: KyAppSystemStatus;
  registeredDigest: string | null;
  runtime: KyAppInstallationRuntimeRecord | null;
  failureThreshold: number;
}): KyAppMineState {
  if (input.installationStatus !== 'enabled') return 'disabled';
  if (input.definitionStatus !== 'published') return 'disabled';
  const runtime = input.runtime;
  if (!runtime) return 'enabled';
  if (runtime.liveStatus === 'maintenance') return 'maintenance';
  if (runtime.liveStatus === 'failed' && runtime.consecutiveFailures >= input.failureThreshold) {
    return 'unavailable';
  }
  if (
    runtime.readyStatus === 'ok'
    && runtime.manifestDigest !== null
    && input.registeredDigest !== null
    && runtime.manifestDigest !== input.registeredDigest
  ) {
    return 'needs_reregistration';
  }
  return 'enabled';
}

export function createKyAppMineRouter(options: KyAppMineRoutesOptions): Router {
  const router = Router();
  const failureThreshold = options.failureThreshold ?? DEFAULT_MINE_FAILURE_THRESHOLD;

  router.get('/systems/mine', async (req, res) => {
    if (!req.user) return sendKyAppError(req, res, 'unauthorized', '需要登录');
    try {
      // 分配事实源不可用时 fail-closed：宁可看不到，也不越权展示。
      if (!options.assignments) return res.json({ installations: [] });
      const installations = await options.systems.listInstallationsForTenant(req.user.tenantId);
      if (installations.length === 0) return res.json({ installations: [] });

      const effective = options.assignments.listVisibleInstallationIds
        ? await options.assignments.listVisibleInstallationIds(req.user.tenantId, req.user.sub)
        : await options.assignments.listEffectiveResourceIds(req.user.tenantId, req.user.sub, 'system_installation');
      const allowed = new Set(effective.map((item) => item.resourceId));

      const visible: KyAppVisibleInstallation[] = [];
      for (const installation of installations) {
        // `pending` 从未启用过（域名还没验），客户从来没在侧边栏见过它 ——
        // 给一个「暂不可用」的空标签只是噪音。`deleted` 已被 store 层滤掉。
        if (installation.status !== 'enabled' && installation.status !== 'disabled') continue;

        const definition = await options.systems.getDefinition(installation.systemId);
        // 从未发布过的系统同理：没有可展示的名字，客户也没见过。
        if (!definition?.publishedDigest) continue;

        // 启停保留原 Assignment；所有状态都按同一授权事实源过滤。
        const active = installation.status === 'enabled' && definition.status === 'published';
        if (!allowed.has(installation.installationId)) continue;

        // 未做过 CAS 切换的实例以「已发布 digest」为准，与取 manifest 版本同一口径。
        const effectiveDigest = installation.registeredDigest ?? definition.publishedDigest;
        const version = await options.systems.getVersion(installation.systemId, effectiveDigest);
        const manifest = (version?.manifest ?? {}) as { name?: unknown; icon?: unknown };
        const runtime = active
          ? ((await options.runtimeStore?.get(installation.installationId)) ?? null)
          : null;
        visible.push({
          installationId: installation.installationId,
          systemId: installation.systemId,
          name: typeof manifest.name === 'string' ? manifest.name : definition.name,
          icon: typeof manifest.icon === 'string' ? manifest.icon : null,
          origin: installation.origin,
          state: resolveMineState({
            installationStatus: installation.status,
            definitionStatus: definition.status,
            registeredDigest: effectiveDigest,
            runtime,
            failureThreshold,
          }),
          externalLinkHosts: parseExternalLinkHosts(version?.manifest),
        });
      }
      res.json({ installations: visible });
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  return router;
}
