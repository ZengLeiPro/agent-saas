import { z } from 'zod';

export const sessionAutomationConfigSchema = z.object({
  controlEnabled: z.boolean().default(false),
  executionEnabled: z.boolean().default(false),
  fixedLoopEnabled: z.boolean().default(false),
  adaptiveLoopEnabled: z.boolean().default(false),
  goalEnabled: z.boolean().default(false),
  evaluatorEnforced: z.boolean().default(false),
});
