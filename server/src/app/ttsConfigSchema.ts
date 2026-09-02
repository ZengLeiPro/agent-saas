import { z } from 'zod';

export const ttsConfigSchema = z.object({
  /** Fail closed in every environment; credentials alone never enable synthesis. */
  enabled: z.boolean().default(false),
  doubaoAppId: z.string(),
  doubaoApiKey: z.string(),
  doubaoCluster: z.string().optional(),
  defaultVoice: z.string().optional(),
  defaultSpeed: z.number().positive().optional(),
});
