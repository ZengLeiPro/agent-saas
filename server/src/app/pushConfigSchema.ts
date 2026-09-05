import { z } from 'zod';

/**
 * 推送通知两条通道的配置：浏览器 Web Push（VAPID）与 iOS 系统推送（APNs）。
 * 两者各自可独立启用；投递面在 runtimeWebPush 装配层扇出到所有已配置的通道。
 */

export const webPushConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    publicKey: z.string().min(1).optional(),
    privateKey: z.string().min(1).optional(),
    subject: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.enabled) return;
    for (const key of ['publicKey', 'privateKey', 'subject'] as const) {
      if (!value[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `webPush.enabled=true 时必须配置 ${key}`,
        });
      }
    }
    if (
      value.subject &&
      !value.subject.startsWith('mailto:') &&
      !value.subject.startsWith('https://')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['subject'],
        message: 'webPush.subject 必须是 mailto: 或 https:// URL',
      });
    }
  });

export const APNS_ENVIRONMENTS = ['production', 'sandbox'] as const;
export type ApnsEnvironment = (typeof APNS_ENVIRONMENTS)[number];

/**
 * APNs 走 Token-based（.p8 Auth Key）鉴权，不用证书。
 * privateKey 为 .p8 文件的 PEM 全文（含 BEGIN/END 行），只放服务端配置。
 * environment 是服务端默认投递环境；App 注册设备时可按构建档位覆盖
 * （TestFlight / App Store 包为 production，开发包为 sandbox）。
 */
export const apnsConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    teamId: z.string().min(1).optional(),
    keyId: z.string().min(1).optional(),
    privateKey: z.string().min(1).optional(),
    /** apns-topic，即 iOS App 的 Bundle ID。 */
    bundleId: z.string().min(1).optional(),
    environment: z.enum(APNS_ENVIRONMENTS).default('production'),
  })
  .superRefine((value, ctx) => {
    if (!value.enabled) return;
    for (const key of ['teamId', 'keyId', 'privateKey', 'bundleId'] as const) {
      if (!value[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `apns.enabled=true 时必须配置 ${key}`,
        });
      }
    }
    if (value.privateKey && !value.privateKey.includes('-----BEGIN')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['privateKey'],
        message: 'apns.privateKey 必须是 .p8 Auth Key 的 PEM 全文',
      });
    }
  });
