import { Router } from 'express';
import { z } from 'zod';

import { requirePlatformAdmin } from '../auth/middleware.js';
import type { ProviderQuotaService } from '../quota/providerQuotaService.js';

export interface CreateProviderQuotaAdminRouterOptions {
  /** 仅 PG runtime 装配；缺省时接口返回 503 而不是假数据。 */
  service?: Pick<ProviderQuotaService, 'overview' | 'history' | 'refresh' | 'test'>;
}

const testRequestSchema = z.object({
  provider: z.literal('volcengine_ark_plan'),
  accessKeyId: z.string().trim().min(1, '缺少 Access Key ID'),
  secretAccessKey: z.string().optional(),
  groupId: z.string().optional(),
  region: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]+$/u, 'Region 格式不正确')
    .optional(),
});

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 平台分析「套餐额度」页 + 模型配置页「测试连接」的数据接口。 */
export function createProviderQuotaAdminRouter(
  options: CreateProviderQuotaAdminRouterOptions,
): Router {
  const router = Router();
  router.use(requirePlatformAdmin);
  router.use((_req, res, next) => {
    if (!options.service) {
      res.status(503).json({ error: '套餐额度采集未启用：需要 PG runtime event store' });
      return;
    }
    next();
  });

  router.get('/', async (_req, res) => {
    try {
      res.json(await options.service!.overview());
    } catch (error) {
      res.status(500).json({ error: message(error) });
    }
  });

  router.get('/history', async (req, res) => {
    const hours = Number.parseInt(String(req.query.hours ?? '24'), 10);
    try {
      res.json(await options.service!.history(Number.isFinite(hours) ? hours : 24));
    } catch (error) {
      res.status(500).json({ error: message(error) });
    }
  });

  router.post('/refresh', async (_req, res) => {
    try {
      await options.service!.refresh();
      res.json(await options.service!.overview());
    } catch (error) {
      res.status(502).json({ error: message(error) });
    }
  });

  router.post('/test', async (req, res) => {
    const parsed = testRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((issue) => issue.message).join('；') });
      return;
    }
    try {
      res.json(await options.service!.test(parsed.data));
    } catch (error) {
      res.status(400).json({ error: message(error) });
    }
  });

  return router;
}
