/**
 * WP2a `GET /api/systems/mine`（规范 §8.1 最后一条）。
 *
 * 可见性完全由服务端计算：本组织 + 实例 `enabled` + `resource_assignments` 命中
 * （只写 `everyone`，所以等价于「本组织全员可见」）+ 系统定义已发布。
 * 返回值只含壳渲染标签所需的最小字段，不泄漏 baseUrl 之外的运维信息。
 */
import { Router } from 'express';

import type { PgAssignmentStore } from '../../data/assignments/store.js';
import type { PgKyAppSystemStore } from '../systems/store.js';
import { sendKyAppError, sendKyAppFailure } from './support.js';

export interface KyAppMineRoutesOptions {
  systems: PgKyAppSystemStore;
  assignments?: PgAssignmentStore;
}

export interface KyAppVisibleInstallation {
  installationId: string;
  systemId: string;
  name: string;
  icon: string | null;
  origin: string;
  state: 'enabled';
}

export function createKyAppMineRouter(options: KyAppMineRoutesOptions): Router {
  const router = Router();

  router.get('/systems/mine', async (req, res) => {
    if (!req.user) return sendKyAppError(req, res, 'unauthorized', '需要登录');
    try {
      const installations = await options.systems.listInstallationsForTenant(req.user.tenantId);
      const enabled = installations.filter((item) => item.status === 'enabled');
      if (enabled.length === 0) return res.json({ installations: [] });

      // 分配事实源不可用时 fail-closed：宁可看不到，也不越权展示。
      if (!options.assignments) return res.json({ installations: [] });
      const effective = await options.assignments.listEffectiveResourceIds(
        req.user.tenantId,
        req.user.sub,
        'system_installation',
      );
      const allowed = new Set(effective.map((item) => item.resourceId));

      const visible: KyAppVisibleInstallation[] = [];
      for (const installation of enabled) {
        if (!allowed.has(installation.installationId)) continue;
        const definition = await options.systems.getDefinition(installation.systemId);
        if (definition?.status !== 'published' || !definition.publishedDigest) continue;
        const version = await options.systems.getVersion(
          installation.systemId,
          installation.registeredDigest ?? definition.publishedDigest,
        );
        const manifest = (version?.manifest ?? {}) as { name?: unknown; icon?: unknown };
        visible.push({
          installationId: installation.installationId,
          systemId: installation.systemId,
          name: typeof manifest.name === 'string' ? manifest.name : definition.name,
          icon: typeof manifest.icon === 'string' ? manifest.icon : null,
          origin: installation.origin,
          state: 'enabled',
        });
      }
      res.json({ installations: visible });
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  return router;
}
