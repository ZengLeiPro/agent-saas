import { z } from "zod";

export const scenarioModeSchema = z.enum(["recurring", "oneshot"]);
export const scenarioRequirementSchema = z.enum(["web", "dingtalk", "internal_system", "upload"]);
export const industryTypeSchema = z.enum([
  "manufacturing",
  "trade",
  "retail",
  "service",
  "export",
  "ecommerce",
]);
export const firstAhaModeSchema = z.enum([
  "zero_input_example",
  "paste_then_result",
  "upload_then_result",
  "voice_then_result",
]);
export const dataDependencyLevelSchema = z.enum(["zero", "upload", "ding", "internal_system"]);
export const pushChannelSchema = z.enum(["ding_work_notification", "ding_group", "ding_both"]);
export const pushTargetSchema = z.enum(["self", "manager", "group"]);
export const humanAuditPolicySchema = z.enum([
  "ai_draft_human_review_human_send",
  "ai_draft_human_review_ai_send",
  "ai_auto_no_audit_forbidden",
]);
export const skillLevelSchema = z.enum(["tenant", "user", "platform"]);
export const dataSourceDifficultySchema = z.enum([
  "zero",
  "self_service_lt_30min",
  "self_service_1_3_days",
  "field_engineering_1_2_weeks",
  "field_assessment_gt_2_weeks",
]);
export const retentionDaySchema = z.enum(["D1", "D2", "D3", "D5", "D7"]);
export const day1PathStageSchema = z.enum(["T+0-30min", "T+30min-1h", "T+1h-4h"]);

export const scenarioSlotSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  example: z.string().min(1),
});

export const scenarioExampleDataLabelSchema = z.enum([
  "synthetic",
  "desensitized",
  "public",
]);

export const scenarioExampleResultSchema = z.object({
  /** 完整示例交付物（markdown），单场景控制在 80-200 行 */
  body: z.string().min(1).max(20_000),
  dataLabel: scenarioExampleDataLabelSchema,
});

export const day1PathStepSchema = z.object({
  stage: day1PathStageSchema,
  userAction: z.string().min(1),
  aiAction: z.string().min(1),
  userSees: z.string().min(1),
});

export const salesPitchBossQnASchema = z.object({
  q: z.string().min(1),
  a: z.string().min(1),
});

export const salesPitchSchema = z.object({
  oralScript: z.string().min(1).max(800),
  demoSteps: z.array(z.string().min(1)).min(1).max(8),
  bossQnA: z.array(salesPitchBossQnASchema).min(1).max(10),
});

export const skillCandidateSchema = z.object({
  name: z.string().min(1),
  level: skillLevelSchema,
  firstSampleGate: z.string().min(1),
  freshnessMechanism: z.string().min(1),
  roiVisibility: z.string().min(1),
});

export const activationFallbackSchema = z.object({
  withoutData: z.string().min(1),
  degradedContent: z.string().min(1),
});

export const signalAdaptationSchema = z.object({
  dailyEmptyStreakToWeekly: z.number().int().min(1).max(14),
  userNoOpenStreakToPause: z.number().int().min(1).max(30),
  emptyContentFallback: z.string().min(1),
});

export const pushSlotSchema = z.object({
  channel: pushChannelSchema,
  target: pushTargetSchema,
  humanReviewRequired: z.boolean(),
});

export const roleWelcomeMessageBranchSchema = z.object({
  default: z.string().min(1).optional(),
  internal: z.string().min(1).optional(),
  export: z.string().min(1).optional(),
});

export const roleWelcomeMessageSchema = z.union([
  z.string().min(1),
  roleWelcomeMessageBranchSchema,
]);

export const roleP0DataSourceSchema = z.object({
  name: z.string().min(1),
  difficulty: dataSourceDifficultySchema,
  afterConnected: z.string().min(1),
  customerAction: z.string().min(1),
});

export const demoIndustryTagSchema = z.object({
  industry: industryTypeSchema,
  sampleScenarioId: z.string().min(1),
});

export const retentionPath7DayItemSchema = z.object({
  day: retentionDaySchema,
  mainlineAiAction: z.string().min(1),
  backupCsmAction: z.string().min(1).optional(),
  sellUpBanned: z.boolean(),
});

export const scenarioRoleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  sort: z.number().int().min(0),
  roleWelcomeMessage: roleWelcomeMessageSchema.optional(),
  roleTopPains: z.array(z.string().min(1)).length(5).optional(),
  roleP0DataSources: z.array(roleP0DataSourceSchema).min(1).optional(),
  defaultRecurringId: z.union([
    z.string().min(1),
    z.array(z.string().min(1)).min(1),
  ]).optional(),
  demoIndustryTag: z.array(demoIndustryTagSchema).min(1).optional(),
  retentionPath7Day: z.array(retentionPath7DayItemSchema).min(3).max(5).optional(),
});

export const scenarioItemSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    role: z.string().min(1),
    industries: z.array(z.string().min(1)).min(1),
    mode: scenarioModeSchema,
    pitch: z.string().min(1),
    story: z.string().min(1),
    promptTemplate: z.string().min(1),
    slots: z.array(scenarioSlotSchema),
    requires: z.array(scenarioRequirementSchema),
    recommendCron: z.boolean(),
    welcomeMessage: z.string().min(1).max(500).optional(),
    day1PathSteps: z.array(day1PathStepSchema).length(3).optional(),
    cannotPromise: z.array(z.string().min(1)).min(1).max(14).optional(),
    skillCandidates: z.array(skillCandidateSchema).min(1).optional(),
    industryFocus: z.array(industryTypeSchema).min(1).optional(),
    dataDependencyLevel: dataDependencyLevelSchema.optional(),
    activationFallback: activationFallbackSchema.optional(),
    signalAdaptation: signalAdaptationSchema.optional(),
    pushSlot: pushSlotSchema.optional(),
    humanAuditPolicy: humanAuditPolicySchema.optional(),
    firstAhaMode: firstAhaModeSchema.optional(),
    exampleResult: scenarioExampleResultSchema.optional(),
  })
  .superRefine((val, ctx) => {
    if (val.mode !== "recurring") return;
    if (!val.signalAdaptation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["signalAdaptation"],
        message: `场景 ${val.id} 是常驻监测，signalAdaptation 必填`,
      });
    }
    if (!val.pushSlot) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pushSlot"],
        message: `场景 ${val.id} 是常驻监测，pushSlot 必填`,
      });
    }
  });

export const scenarioItemInternalSchema = scenarioItemSchema.and(
  z.object({
    source: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    salesPitch: salesPitchSchema.optional(),
  }),
);

export const scenarioLibraryFileSchema = z.object({
  $schema: z.string().optional(),
  version: z.union([z.literal(1), z.literal(2)]),
  updatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  roles: z.array(scenarioRoleSchema).min(1),
  scenarios: z.array(scenarioItemInternalSchema).min(1),
});

export const roleKitSchema = z.object({
  role: scenarioRoleSchema,
  scenarios: z.array(scenarioItemInternalSchema).min(1),
});

export type ScenarioLibraryFileParsed = z.infer<typeof scenarioLibraryFileSchema>;
export type ScenarioItemParsed = z.infer<typeof scenarioItemSchema>;
export type ScenarioItemInternalParsed = z.infer<typeof scenarioItemInternalSchema>;
export type ScenarioRoleParsed = z.infer<typeof scenarioRoleSchema>;
export type SalesPitchParsed = z.infer<typeof salesPitchSchema>;
export type RoleKitParsed = z.infer<typeof roleKitSchema>;
