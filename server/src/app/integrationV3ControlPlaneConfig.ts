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
  /** v3 writes are bound to exactly one GitHub App installation. */
  githubAppInstallationId: z.number().int().positive(),
  githubTokenMode: z.literal('github_app').default('github_app'),
  /** Optional only so disabled/test-injected runtimes remain representable; enabled production fails closed without it. */
  githubApp: githubAppConfigSchema.optional(),
}).optional();
