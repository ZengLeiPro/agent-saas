import { z } from 'zod';
import { GROK_RESPONSES_ENDPOINT } from '../runtime/responses/grokProtocol.js';
const credentialRef = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\s\u0000-\u001f\u007f]+$/);
export const grokSubscriptionConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    quotaCooldownMinutes: z.number().int().min(1).max(10_080).default(60),
    credentialRef: credentialRef.optional(),
    credentialRefs: z.array(credentialRef).min(1).max(100).optional(),
    endpoint: z.literal(GROK_RESPONSES_ENDPOINT).optional(),
    oauthClientId: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9._-]+$/)
      .optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    const refs = config.credentialRefs ?? (config.credentialRef ? [config.credentialRef] : []);
    if (config.enabled && refs.length === 0)
      ctx.addIssue({ code: 'custom', path: ['enabled'], message: '启用 Grok 订阅前必须登记账号' });
    if (new Set(refs).size !== refs.length)
      ctx.addIssue({ code: 'custom', path: ['credentialRefs'], message: 'Grok 账号列表不能重复' });
    if (
      config.credentialRef &&
      config.credentialRefs &&
      config.credentialRef !== config.credentialRefs[0]
    )
      ctx.addIssue({
        code: 'custom',
        path: ['credentialRef'],
        message: 'Grok 首账号别名必须与优先级列表一致',
      });
  });
