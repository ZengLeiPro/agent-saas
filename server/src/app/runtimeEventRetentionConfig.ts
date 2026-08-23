import { z } from 'zod';

export const runtimeEventRetentionConfigSchema = z.object({
  enabled: z.boolean().optional(),
  executionMode: z.enum(['dry-run', 'execute']).optional(),
  legalDeleteThroughGlobalSequence: z.string().regex(/^\d+$/).optional(),
  authorizationRef: z.string().trim().min(1).max(200).optional(),
  sweepIntervalMinutes: z.number().int().min(1).max(24 * 60).optional(),
  batchLimit: z.number().int().min(1).max(100_000).optional(),
  maxBatchesPerCategory: z.number().int().min(1).max(1000).optional(),
  terminalDeltaGraceMinutes: z.number().int().min(1).max(24 * 60).optional(),
  successfulSummaryRetentionHours: z.number().int().min(1).max(365 * 24).optional(),
  failedSummaryRetentionDays: z.number().int().min(1).max(3650).optional(),
  modelDiagnosticRetentionDays: z.number().int().min(1).max(3650).optional(),
  modelRequestFinishedRetentionDays: z.number().int().min(1).max(3650).optional(),
  handEventRetentionDays: z.number().int().min(1).max(3650).optional(),
  billingCatchupBatchLimit: z.number().int().min(1).max(100_000).optional(),
  billingCatchupMaxBatches: z.number().int().min(1).max(10_000).optional(),
}).superRefine((value, ctx) => {
  if (value.executionMode === 'execute' && !value.authorizationRef) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['authorizationRef'],
      message: 'runtime retention execute 模式必须提供 authorizationRef',
    });
  }
  if (
    value.executionMode === 'execute'
    && (!value.legalDeleteThroughGlobalSequence || BigInt(value.legalDeleteThroughGlobalSequence) <= 0n)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['legalDeleteThroughGlobalSequence'],
      message: 'runtime retention execute 模式必须提供正数 legalDeleteThroughGlobalSequence',
    });
  }
  if (
    value.modelDiagnosticRetentionDays !== undefined
    && value.modelRequestFinishedRetentionDays !== undefined
    && value.modelRequestFinishedRetentionDays < value.modelDiagnosticRetentionDays
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['modelRequestFinishedRetentionDays'],
      message: 'modelRequestFinishedRetentionDays 不得短于 modelDiagnosticRetentionDays',
    });
  }
});

export function retentionWorkerOptions(config: z.infer<typeof runtimeEventRetentionConfigSchema> | undefined) {
  return {
    enabled: config?.enabled,
    executionMode: config?.executionMode,
    legalDeleteThroughGlobalSequence: config?.legalDeleteThroughGlobalSequence,
    authorizationRef: config?.authorizationRef,
    sweepIntervalMinutes: config?.sweepIntervalMinutes,
    batchLimit: config?.batchLimit,
    maxBatchesPerCategory: config?.maxBatchesPerCategory,
    terminalDeltaGraceMinutes: config?.terminalDeltaGraceMinutes,
    successfulSummaryRetentionHours: config?.successfulSummaryRetentionHours,
    failedSummaryRetentionDays: config?.failedSummaryRetentionDays,
    modelDiagnosticRetentionDays: config?.modelDiagnosticRetentionDays,
    modelRequestFinishedRetentionDays: config?.modelRequestFinishedRetentionDays,
    handEventRetentionDays: config?.handEventRetentionDays,
    billingCatchupBatchLimit: config?.billingCatchupBatchLimit,
    billingCatchupMaxBatches: config?.billingCatchupMaxBatches,
  };
}
