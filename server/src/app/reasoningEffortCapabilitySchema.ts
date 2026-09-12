import { z } from 'zod';

/** 显式能力目录；没有可信配置时调用侧必须保持 unknown，不能按模型名称猜。 */
const reasoningEffortCapabilitySchema = z
  .object({
    support: z.enum(['supported', 'unsupported', 'unknown']),
    values: z
      .array(z.string().trim().min(1).max(64))
      .min(1)
      .max(32)
      .refine(
        (values) => new Set(values).size === values.length,
        'reasoning effort values 不能重复',
      )
      .optional(),
    default_value: z.string().trim().min(1).max(64).optional(),
    source: z.enum(['configured', 'verified_provider']).optional(),
  })
  .strict()
  .superRefine((capability, ctx) => {
    if (
      capability.default_value &&
      capability.values &&
      !capability.values.includes(capability.default_value)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['default_value'],
        message: 'reasoning effort 默认值必须包含在 values 中',
      });
    }
    if (capability.support === 'supported' && !capability.values?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['values'],
        message: 'supported 能力必须声明至少一个已验证值',
      });
    }
    if (capability.support !== 'supported' && (capability.values || capability.default_value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['support'],
        message: 'unsupported/unknown 能力不能声明 values 或 default_value',
      });
    }
  });

export const reasoningEffortProviderOptionShape = {
  reasoning_effort: z.string().optional(),
  reasoningEffort: z.string().optional(),
  reasoning_effort_capability: reasoningEffortCapabilitySchema.optional(),
};
