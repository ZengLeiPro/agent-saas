import { randomUUID } from 'node:crypto';

import { HTTP_HEADERS } from '@kaiyan/ky-app-contract';
import { Hono } from 'hono';

import { KyAppError } from '../errors.js';
import { issueV2Attestation } from '../identity/attest.js';
import { errorResponder } from './middleware.js';
import type { KyAppV2RouterOptions, KyAppVariables } from './types.js';

export function createKyAppV2Router(
  options: KyAppV2RouterOptions & { manifestDigest: string; now?: () => number },
): Hono<{ Variables: KyAppVariables }> {
  const app = new Hono<{ Variables: KyAppVariables }>();
  const now = options.now ?? Date.now;
  app.use('*', async (c, next) => {
    const incoming = c.req.header(HTTP_HEADERS.requestId);
    const requestId = incoming && incoming.length <= 128 ? incoming : randomUUID();
    c.set('kyRequestId', requestId);
    await next();
    c.header(HTTP_HEADERS.requestId, requestId);
  });
  app.onError((error, c) => errorResponder(c, error));

  app.get('/ky/v2/health/live', (c) =>
    c.json({ ok: true, integration: options.enabled ? 'unbound_or_bound' : 'disabled' }),
  );
  app.post('/ky/v2/enrollment/challenge', async (c) => {
    if (!options.enabled) throw new KyAppError('not_found', { message: '自动接入未开启' });
    const authorization = c.req.header('authorization') ?? '';
    if (!authorization.startsWith('Bearer '))
      throw new KyAppError('unauthorized', { message: '缺少平台证明' });
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') throw new KyAppError('invalid_input');
    const value = body as Record<string, unknown>;
    const names = [
      'operationId',
      'nonce',
      'platformIssuer',
      'installationId',
      'tenantId',
      'systemId',
      'origin',
      'callbackUrl',
    ] as const;
    if (names.some((name) => typeof value[name] !== 'string'))
      throw new KyAppError('invalid_input');
    try {
      return c.json(
        await options.enrollment.challenge(
          {
            operationId: value.operationId as string,
            nonce: value.nonce as string,
            platformIssuer: value.platformIssuer as string,
            installationId: value.installationId as string,
            tenantId: value.tenantId as string,
            systemId: value.systemId as string,
            origin: value.origin as string,
            callbackUrl: value.callbackUrl as string,
          },
          authorization.slice('Bearer '.length),
        ),
      );
    } catch (error) {
      // 管理员尚未允许接入时隐藏端点能力，不能把内部开关状态作为 500 暴露出去。
      if (error instanceof Error && error.message === 'enrollment_disabled') {
        throw new KyAppError('not_found', { message: '自动接入未开启' });
      }
      throw error;
    }
  });
  app.get('/ky/v2/enrollment/callback', async (c) => {
    if (!options.enabled) throw new KyAppError('not_found', { message: '自动接入未开启' });
    const code = c.req.query('code');
    const state = c.req.query('state');
    if (!code || !state) throw new KyAppError('invalid_input', { message: '缺少 code/state' });
    await options.enrollment.callback(code, state);
    c.header('cache-control', 'no-store');
    c.header('referrer-policy', 'no-referrer');
    return c.html(
      '<!doctype html><meta charset="utf-8"><title>接入完成</title><script>history.replaceState(null,"","/ky/v2/enrollment/complete")</script><p>组织接入已完成，可以关闭此页面。</p>',
    );
  });
  app.get('/ky/v2/attest', async (c) => {
    if (!options.enabled) throw new KyAppError('not_found', { message: 'V2 未开启' });
    const iid = c.req.query('iid');
    const nonce = c.req.query('nonce');
    if (!iid || !nonce) throw new KyAppError('invalid_input');
    const binding = await options.bindings.get(iid);
    if (!binding || binding.state === 'revoked') throw new KyAppError('not_found');
    return c.json({
      attestation: await issueV2Attestation({
        binding,
        nonce,
        manifestDigest: options.manifestDigest,
        ready: binding.state === 'connected',
        keys: options.keys,
        now: now(),
      }),
    });
  });
  app.get('/ky/v2/integration/status', async (c) => {
    if (!options.enabled) return c.json({ enabled: false, bindings: [] });
    if (!(await options.authorizeStatus(c.req.header('authorization') ?? null))) {
      throw new KyAppError('unauthorized');
    }
    const bindings = (await options.bindings.list()).map((binding) => ({
      installationId: binding.installationId,
      organizationId: binding.tenantId,
      systemId: binding.systemId,
      origin: binding.origin,
      keyFingerprint: binding.keyId.slice(0, 8),
      generation: binding.generation,
      state: binding.state,
      updatedAt: binding.updatedAt,
    }));
    return c.json({ enabled: true, bindings });
  });
  return app;
}
