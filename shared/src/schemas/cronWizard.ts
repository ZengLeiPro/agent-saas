import { z } from "zod";

const pushChannelSchema = z.enum(["ding_work_notification", "ding_group", "ding_both"]);
const pushTargetSchema = z.enum(["self", "manager", "group"]);

export const cronWizardStep1Schema = z.object({
  monitorTargets: z.array(z.string().min(1).max(120)).min(1, "至少填 1 个监测对象").max(10),
});

export const cronWizardStep2Schema = z.object({
  dailyEmptyStreakToWeekly: z.number().int().min(1).max(14),
  userNoOpenStreakToPause: z.number().int().min(1).max(30),
  emptyContentFallback: z.string().min(1).max(200),
});

export const cronWizardStep3Schema = z.discriminatedUnion("humanReviewRequired", [
  z.object({
    humanReviewRequired: z.literal(false),
    target: pushTargetSchema,
    channel: pushChannelSchema,
  }),
  z.object({
    humanReviewRequired: z.literal(true),
    target: z.literal("manager"),
    channel: z.literal("ding_work_notification"),
  }),
]);

export const cronWizardSubmitSchema = z.object({
  scenarioId: z.string().min(1),
  monitorTargets: cronWizardStep1Schema.shape.monitorTargets,
  signalAdaptation: cronWizardStep2Schema,
  pushSlot: cronWizardStep3Schema,
});

export const cronWizardResponseSchema = z.object({
  cronJobId: z.string().min(1),
  scenarioId: z.string().min(1),
  createdAt: z.string(),
});

export type CronWizardStep1 = z.infer<typeof cronWizardStep1Schema>;
export type CronWizardStep2 = z.infer<typeof cronWizardStep2Schema>;
export type CronWizardStep3 = z.infer<typeof cronWizardStep3Schema>;
export type CronWizardSubmit = z.infer<typeof cronWizardSubmitSchema>;
export type CronWizardResponse = z.infer<typeof cronWizardResponseSchema>;
