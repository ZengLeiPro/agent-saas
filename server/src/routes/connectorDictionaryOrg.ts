/**
 * 组织管理端「连接器映射」API（2026-08-04 任务 E）。
 *
 * GET    /api/org/connector-dictionary           平台条目 + 本租户覆盖
 * PUT    /api/org/connector-dictionary/:binary   新增或整条覆盖本租户的一个连接器
 * DELETE /api/org/connector-dictionary/:binary   移除本租户覆盖（回落平台条目）
 *
 * 合并规则（曾磊拍板，任务书 v2）：租户条目按 binary **整条覆盖**平台条目，
 * 不做字段级 merge——半平台半租户的杂交条目没人能推理。响应把两层分开返回
 * （platform / overrides），合并视图由 UI 呈现，运行时合并在
 * toolPresentationBuilder 的预计算视图里完成。
 *
 * 权限（仿 orgAgents 三档的前两档）：组织 admin 管本租户；平台 admin 可带
 * `?tenantId=` 跨组织。普通用户无入口。
 *
 * 热更新语义与平台词典一致：落库 → 立刻刷新本进程运行时 → Runtime Worker
 * 进程靠 runtime.ts 的 60s 定时刷新（保存后 ≤60s 全进程生效）。
 */

import { Router } from 'express';

import { requireAdmin } from '../auth/middleware.js';
import { isPlatformAdmin } from '../auth/types.js';
import { auditLog } from '../data/login-logs/index.js';
import {
  assertConnectorBinary,
  assertConnectorTenantId,
  normalizeConnectorEntry,
  type ConnectorDictionaryRecord,
  type ConnectorDictionaryStore,
} from '../data/connectorDictionaryStore.js';
import {
  setConnectorDictionary,
  setTenantConnectorDictionaries,
} from '../agent/toolPresentationBuilder.js';

export interface CreateConnectorDictionaryOrgRouterOptions {
  store: ConnectorDictionaryStore;
  /** 保存后把两层词典推给运行时；缺省用内置 setter（测试注入用） */
  applyDictionaries?: (
    platform: ConnectorDictionaryRecord[],
    overrides: Record<string, ConnectorDictionaryRecord[]>,
  ) => void;
}

function actorOf(req: { user?: { username?: string; id?: string } }): string {
  return req.user?.username ?? req.user?.id ?? 'unknown';
}

/** 组织 admin 只能动自己的租户；平台 admin 可用 ?tenantId= 指定 */
function resolveTargetTenantId(req: {
  user?: { tenantId?: string; role?: string };
  query: Record<string, unknown>;
}): string {
  const own = req.user?.tenantId;
  const queried = typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined;
  if (queried && queried !== own) {
    if (!isPlatformAdmin(req.user as Parameters<typeof isPlatformAdmin>[0])) {
      throw Object.assign(new Error('无权管理其他组织的连接器映射'), { statusCode: 403 });
    }
    return assertConnectorTenantId(queried);
  }
  if (!own) throw Object.assign(new Error('当前账号缺少组织信息'), { statusCode: 400 });
  return assertConnectorTenantId(own);
}

export function createConnectorDictionaryOrgRouter(
  options: CreateConnectorDictionaryOrgRouterOptions,
): Router {
  const router = Router();
  router.use(requireAdmin);

  const apply = options.applyDictionaries
    ?? ((platform: ConnectorDictionaryRecord[], overrides: Record<string, ConnectorDictionaryRecord[]>) => {
      setConnectorDictionary(platform);
      setTenantConnectorDictionaries(overrides);
    });

  /** 任何写操作后统一走这条路刷新运行时（本进程即时；Worker 进程 ≤60s 定时刷） */
  const refresh = async (): Promise<void> => {
    const [platform, overrides] = await Promise.all([
      options.store.listPlatform(),
      options.store.listAllTenantOverrides(),
    ]);
    apply(platform, overrides);
  };

  const respond = async (res: { json(body: unknown): void }, tenantId: string): Promise<void> => {
    const [platform, overrides] = await Promise.all([
      options.store.listPlatform(),
      options.store.listTenant(tenantId),
    ]);
    res.json({ tenantId, platform, overrides });
  };

  router.get('/', async (req, res) => {
    try {
      const tenantId = resolveTargetTenantId(req);
      await respond(res, tenantId);
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode ?? 500;
      res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.put('/:binary', async (req, res) => {
    let tenantId: string;
    let entry;
    try {
      tenantId = resolveTargetTenantId(req);
      const binary = assertConnectorBinary(req.params.binary);
      entry = normalizeConnectorEntry({ ...(req.body ?? {}), binary });
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode ?? 400;
      res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    try {
      const saved = await options.store.upsertTenant(tenantId, entry, actorOf(req));
      await refresh();
      auditLog(req, 'connector_dictionary_tenant_updated', `${tenantId}/${saved.binary}`);
      await respond(res, tenantId);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete('/:binary', async (req, res) => {
    let tenantId: string;
    let binary: string;
    try {
      tenantId = resolveTargetTenantId(req);
      binary = assertConnectorBinary(req.params.binary);
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode ?? 400;
      res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    try {
      const removed = await options.store.removeTenant(tenantId, binary, actorOf(req));
      if (!removed) {
        res.status(404).json({ error: `该组织没有对 ${binary} 的覆盖` });
        return;
      }
      await refresh();
      auditLog(req, 'connector_dictionary_tenant_deleted', `${tenantId}/${binary}`);
      await respond(res, tenantId);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
