import { Router } from 'express';
import { requirePlatformAdmin } from '../auth/middleware.js';
import { GrokSubscriptionCompletion } from './grokSubscriptionCompletion.js';
import {
  createGrokAdminContext,
  GrokAdminInputError,
  grokAdminBody,
  grokAdminOwner,
  refsFromRaw,
  sendGrokAdminError,
  withGrokRefs,
  type GrokSubscriptionAdminOptions,
} from './grokSubscriptionAdminSupport.js';
export type { GrokSubscriptionAdminOptions } from './grokSubscriptionAdminSupport.js';
export function createGrokSubscriptionAdminRouter(options: GrokSubscriptionAdminOptions): Router {
  const router = Router();
  const context = createGrokAdminContext(options);
  const completion = new GrokSubscriptionCompletion(context);
  router.use(requirePlatformAdmin);
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.get('/', async (_req, res) => {
    try {
      res.json(await context.publicState());
    } catch (error) {
      sendGrokAdminError(res, error);
    }
  });
  router.put('/', async (req, res) => {
    try {
      const body = grokAdminBody(req, ['enabled', 'quotaCooldownMinutes', 'oauthClientId']);
      if ('enabled' in body && typeof body.enabled !== 'boolean')
        throw new GrokAdminInputError('enabled 必须是布尔值');
      if (
        'quotaCooldownMinutes' in body &&
        (typeof body.quotaCooldownMinutes !== 'number' ||
          !Number.isInteger(body.quotaCooldownMinutes) ||
          body.quotaCooldownMinutes < 1 ||
          body.quotaCooldownMinutes > 10_080)
      )
        throw new GrokAdminInputError('冷却时间必须是 1 到 10080 之间的整数分钟');
      if (
        'oauthClientId' in body &&
        (typeof body.oauthClientId !== 'string' ||
          !/^[A-Za-z0-9._-]{1,256}$/.test(body.oauthClientId))
      )
        throw new GrokAdminInputError('OAuth client ID 无效');
      await context.mutate(req, 'grok.settings', (current) => {
        const next = {
          ...current,
          ...body,
          enabled: body.enabled ?? current.enabled ?? false,
          quotaCooldownMinutes: body.quotaCooldownMinutes ?? current.quotaCooldownMinutes ?? 60,
        };
        if (next.enabled === true && refsFromRaw(current).length === 0)
          throw new GrokAdminInputError('请先完成至少一个 Grok 账号授权，再启用订阅', 409);
        return next;
      });
      res.json(await context.publicState());
    } catch (error) {
      sendGrokAdminError(res, error);
    }
  });
  router.put('/credentials/order', async (req, res) => {
    try {
      const body = grokAdminBody(req, ['credentialRefs']);
      const requested = body.credentialRefs;
      if (
        !Array.isArray(requested) ||
        requested.some((ref) => typeof ref !== 'string') ||
        requested.length === 0
      )
        throw new GrokAdminInputError('请提交完整的账号优先级列表');
      await context.mutate(req, 'grok.order', (current) => {
        const refs = refsFromRaw(current);
        const set = new Set(requested);
        if (
          refs.length !== requested.length ||
          set.size !== refs.length ||
          refs.some((ref) => !set.has(ref))
        )
          throw new GrokAdminInputError(
            '账号列表已变化或存在重复、缺失、未知账号，请刷新后重试',
            409,
          );
        return withGrokRefs(current, requested as string[]);
      });
      res.json(await context.publicState());
    } catch (error) {
      sendGrokAdminError(res, error);
    }
  });
  router.post('/device/start', async (req, res) => {
    try {
      context.assertWritable();
      const body = grokAdminBody(req, ['credentialRef']);
      if (
        'credentialRef' in body &&
        (typeof body.credentialRef !== 'string' || !body.credentialRef)
      )
        throw new GrokAdminInputError('credentialRef 无效');
      const replaceRef = typeof body.credentialRef === 'string' ? body.credentialRef : undefined;
      if (replaceRef && !options.credentialManager.getCredentialRefs().includes(replaceRef))
        throw new GrokAdminInputError('待重授权账号不存在', 404);
      res
        .status(201)
        .json(
          await options.deviceAuthService.start(
            grokAdminOwner(req),
            replaceRef,
            options.credentialManager.getConfiguration().oauthClientId,
          ),
        );
    } catch (error) {
      sendGrokAdminError(res, error);
    }
  });
  router.get('/device/:sessionId', (req, res) => {
    try {
      const result = options.deviceAuthService.status(req.params.sessionId, grokAdminOwner(req));
      res.status(result.status === 'expired' ? 410 : 200).json(result);
    } catch (error) {
      sendGrokAdminError(res, error);
    }
  });
  router.post('/device/:sessionId/poll', async (req, res) => {
    try {
      context.assertWritable();
      grokAdminBody(req, []);
      const result = await options.deviceAuthService.poll(
        req.params.sessionId,
        grokAdminOwner(req),
      );
      res.status(result.status === 'expired' ? 410 : 200).json(result);
    } catch (error) {
      sendGrokAdminError(res, error);
    }
  });
  router.post('/device/:sessionId/complete', (req, res) => completion.handle(req, res));
  router.delete('/device/:sessionId', (req, res) => {
    try {
      const owner = grokAdminOwner(req);
      grokAdminBody(req, []);
      if (completion.isPending(req.params.sessionId, owner))
        throw new GrokAdminInputError('该授权正在登记，请先刷新登记结果', 409);
      options.deviceAuthService.cancel(req.params.sessionId, owner);
      res.json({ status: 'cancelled' });
    } catch (error) {
      sendGrokAdminError(res, error);
    }
  });
  router.delete('/credentials/:credentialRef', async (req, res) => {
    try {
      grokAdminBody(req, []);
      const ref = req.params.credentialRef;
      await context.mutate(req, 'grok.remove', (current) => {
        const refs = refsFromRaw(current);
        if (!refs.includes(ref)) throw new GrokAdminInputError('Grok 账号不存在', 404);
        const next = refs.filter((entry) => entry !== ref);
        return withGrokRefs(current, next, next.length ? current.enabled === true : false);
      });
      let warning: string | undefined;
      try {
        warning = (await options.credentialManager.revoke(ref)).remoteWarning;
      } catch {
        warning = '账号已从运行配置移除，但凭据清理未确认，请检查 SecretVault。';
      }
      res.json({ ...(await context.publicState()), ...(warning ? { warning } : {}) });
    } catch (error) {
      sendGrokAdminError(res, error);
    }
  });
  router.delete('/', async (req, res) => {
    try {
      grokAdminBody(req, []);
      let removed: string[] = [];
      await context.mutate(req, 'grok.disconnect', (current) => {
        removed = refsFromRaw(current);
        return withGrokRefs(current, [], false);
      });
      const warnings: string[] = [];
      for (const ref of removed) {
        try {
          const { remoteWarning } = await options.credentialManager.revoke(ref);
          if (remoteWarning) warnings.push(remoteWarning);
        } catch {
          warnings.push('部分凭据清理未确认，请检查 SecretVault。');
        }
      }
      res.json({
        ...(await context.publicState()),
        ...(warnings.length ? { warning: [...new Set(warnings)].join('；') } : {}),
      });
    } catch (error) {
      sendGrokAdminError(res, error);
    }
  });
  // Unlike the metadata GET, this explicit collection endpoint may refresh credentials through the shared manager.
  router.get('/models', async (req, res) => {
    try {
      if (!options.modelCatalog) throw new GrokAdminInputError('订阅模型目录服务未装配', 503);
      res.json(await options.modelCatalog.list(req.query.refresh === 'true'));
    } catch (error) {
      sendGrokAdminError(res, error);
    }
  });
  return router;
}
