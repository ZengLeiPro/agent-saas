import { z } from 'zod';

export const codexSubscriptionConfigSchema = z.object({
  enabled: z.boolean().default(false),
  websocketEnabled: z.boolean().default(false),
  quotaCooldownMinutes: z.number().int().min(1).max(10_080).default(60),
  /** SecretVault ref；OAuth access/refresh token 不得直接进入 config.json。 */
  credentialRef: z.string().min(1).optional(),
  credentialRefs: z.array(z.string().min(1)).min(1).optional(),
  endpoint: z
    .string()
    .url()
    .refine((value) => {
      try {
        const url = new URL(value);
        return (
          url.protocol === 'https:' &&
          !url.username &&
          !url.password &&
          url.hostname === 'chatgpt.com' &&
          url.pathname === '/backend-api/codex/responses'
        );
      } catch {
        return false;
      }
    }, '只允许 https://chatgpt.com/backend-api/codex/responses')
    .optional(),
  originator: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/, '必须是 2–64 位字母、数字、点、下划线或连字符')
    .optional(),
});
