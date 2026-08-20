import { z } from 'zod';

const githubAppConfigSchema = z.object({
  /** Public numeric App identity. The private key remains in the server-side vault. */
  appId: z.number().int().positive(),
  privateKeyRef: z.string().min(1),
  /** GitHub Enterprise API root; github.com uses the default. */
  apiBaseUrl: z.string().url().optional(),
});

export const integrationV3ControlPlaneConfigSchema = z.object({
  enabled: z.boolean(),
  controlledMirrorRoot: z.string().min(1),
  githubTokenMode: z.enum(['github_app', 'personal_access_token']).default('github_app'),
  /** Required only in github_app mode. */
  githubAppInstallationId: z.number().int().positive().optional(),
  githubApp: githubAppConfigSchema.optional(),
}).superRefine((value, ctx) => {
  if (value.githubTokenMode === 'github_app' && !value.githubAppInstallationId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['githubAppInstallationId'], message: 'github_app mode requires an installation id' });
  }
}).optional();
