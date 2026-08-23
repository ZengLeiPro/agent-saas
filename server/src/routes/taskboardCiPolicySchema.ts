import { z } from 'zod';

export const boardCiPolicySchema = z.object({
  requiredChecks: z.array(z.object({
    name: z.string().trim().min(1).max(256),
    appId: z.number().int().positive().optional(),
  }).strict()).min(1).max(50).superRefine((checks, ctx) => {
    const identities = new Set<string>();
    checks.forEach((check, index) => {
      const identity = `${check.name}\u0000${check.appId ?? '*'}`;
      if (identities.has(identity)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: 'Required CI check must be unique' });
      identities.add(identity);
    });
  }),
}).strict();
