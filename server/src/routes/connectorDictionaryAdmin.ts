/**
 * 平台管理「连接器映射」API（2026-08-03）。
 *
 * GET    /api/admin/connector-dictionary          读取平台级词典
 * PUT    /api/admin/connector-dictionary/:binary  新增或整条覆盖一个连接器
 * DELETE /api/admin/connector-dictionary/:binary  删除一个连接器
 * POST   /api/admin/connector-dictionary/reset    恢复内置词典
 *
 * 保存语义：落库 → 立刻把整份词典推给运行时（`setConnectorDictionary`）→
 * 下一次工具调用的摘要就按新词典产出。**没有草稿、没有版本**——词典改错的
 * 后果是摘要标题不好看，不是线上行为变了，上审批流属于过度设计。
 *
 * 每次写操作都进平台审计（`auditLog`），detail 只记 binary 与关键计数，
 * 不记整张词典正文——审计流水不是配置备份。
 */

import { Router } from 'express';

import { requirePlatformAdmin } from '../auth/middleware.js';
import { auditLog } from '../data/login-logs/index.js';
import {
  assertConnectorBinary,
  normalizeConnectorEntry,
  type ConnectorDictionaryRecord,
  type ConnectorDictionaryStore,
} from '../data/connectorDictionaryStore.js';
import { cloneBuiltinConnectorDictionary } from '../agent/connectorDictionary.js';
import { setConnectorDictionary } from '../agent/toolPresentationBuilder.js';

export interface CreateConnectorDictionaryAdminRouterOptions {
  store: ConnectorDictionaryStore;
  /** 保存后把整份词典推给运行时；缺省用内置的 setConnectorDictionary */
  applyDictionary?: (entries: ConnectorDictionaryRecord[]) => void;
  logger?: { warn(msg: string): void };
}

function actorOf(req: { user?: { username?: string; id?: string } }): string {
  return req.user?.username ?? req.user?.id ?? 'unknown';
}

function describeEntry(entry: ConnectorDictionaryRecord): string {
  return [
    entry.enabled ? '已启用' : '已停用',
    `系统=${entry.systemName}`,
    `模块 ${Object.keys(entry.modules).length}`,
    `动词 ${Object.keys(entry.actionVerbs).length}`,
    `排除 ${entry.excludePatterns.length}`,
    `域名 ${entry.urlWhitelist.length}`,
  ].join('，');
}

export function createConnectorDictionaryAdminRouter(
  options: CreateConnectorDictionaryAdminRouterOptions,
): Router {
  const router = Router();
  router.use(requirePlatformAdmin);

  const apply = options.applyDictionary ?? ((entries) => setConnectorDictionary(entries));

  /** 落库后统一走这一条路刷新运行时，避免某个分支忘了热更导致「保存了没生效」 */
  const refresh = async (): Promise<ConnectorDictionaryRecord[]> => {
    const entries = await options.store.listPlatform();
    apply(entries);
    return entries;
  };

  router.get('/', async (_req, res) => {
    try {
      const entries = await options.store.listPlatform();
      res.json({ entries, builtin: cloneBuiltinConnectorDictionary() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.put('/:binary', async (req, res) => {
    let entry;
    try {
      const binary = assertConnectorBinary(req.params.binary);
      entry = normalizeConnectorEntry({ ...(req.body ?? {}), binary });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    try {
      const saved = await options.store.upsert(entry, actorOf(req));
      const entries = await refresh();
      auditLog(req, 'connector_dictionary_updated', `${saved.binary}：${describeEntry(saved)}`);
      res.json({ entries, builtin: cloneBuiltinConnectorDictionary() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.delete('/:binary', async (req, res) => {
    let binary: string;
    try {
      binary = assertConnectorBinary(req.params.binary);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    try {
      const removed = await options.store.remove(binary, actorOf(req));
      if (!removed) {
        res.status(404).json({ error: `未找到连接器 ${binary}` });
        return;
      }
      const entries = await refresh();
      auditLog(req, 'connector_dictionary_deleted', binary);
      res.json({ entries, builtin: cloneBuiltinConnectorDictionary() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/reset', async (req, res) => {
    try {
      await options.store.resetToBuiltin(actorOf(req));
      const entries = await refresh();
      auditLog(req, 'connector_dictionary_reset', `恢复内置词典（${entries.length} 个连接器）`);
      res.json({ entries, builtin: cloneBuiltinConnectorDictionary() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  return router;
}
