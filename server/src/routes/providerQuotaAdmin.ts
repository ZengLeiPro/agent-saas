import { Router } from 'express';
import { z } from 'zod';

import { requirePlatformAdmin } from '../auth/middleware.js';
import type { ProviderQuotaService } from '../quota/providerQuotaService.js';

export interface CreateProviderQuotaAdminRouterOptions {
  /** 仅 PG runtime 装配；缺省时接口返回 503 而不是假数据。 */
  service?: Pick<ProviderQuotaService, 'overview' | 'history' | 'refresh' | 'test' | 'setPlanExpiry'>;
}

const testRequestSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('volcengine_ark_plan'),
    accessKeyId: z.string().trim().min(1, '缺少 Access Key ID'),
    secretAccessKey: z.string().optional(),
    groupId: z.string().optional(),
    region: z
      .string()
      .trim()
      .regex(/^[a-z0-9-]+$/u, 'Region 格式不正确')
      .optional(),
  }),
  z.object({
    provider: z.literal('zhipu_coding_plan'),
    apiKey: z.string().trim().max(8192).regex(/^[^\r\n]*$/u, 'API Key 格式不正确').optional(),
    groupId: z.string().trim().min(1).optional(),
  }).strict(),
]).superRefine((input, ctx) => {
  if (input.provider === 'zhipu_coding_plan' && !input.apiKey && !input.groupId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '请填写智谱 API Key 或选择已保存的模型分组' });
  }
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
    res.set('Cache-Control', 'no-store');
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

  router.post('/refresh', async (req, res) => {
    const raw = req.query.accountKey ?? (req.body as { accountKey?: unknown } | undefined)?.accountKey;
    const accountKey = typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
    try {
      await options.service!.refresh(accountKey);
      res.json(await options.service!.overview());
    } catch (error) {
      res.status(502).json({ error: message(error) });
    }
  });

  router.patch('/plan-expiry', async (req, res) => {
    const parsed = z.object({
      accountKey: z.string().trim().min(1),
      endTime: z.string().datetime({ offset: true }).nullable(),
    }).strict().safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: '请提供有效的账号和套餐到期时间' });
      return;
    }
    try {
      await options.service!.setPlanExpiry(parsed.data.accountKey, parsed.data.endTime, req.user!.sub);
    } catch (error) {
      res.status(400).json({ error: message(error) });
      return;
    }
    try {
      res.json(await options.service!.overview());
    } catch (error) {
      res.status(500).json({ error: message(error) });
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
