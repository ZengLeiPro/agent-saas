import { z } from 'zod';

export const integrationV3ControlPlaneConfigSchema = z.object({
  enabled: z.boolean(),
  controlledMirrorRoot: z.string().min(1),
  /** v3 writes are bound to exactly one GitHub App installation. */
  githubAppInstallationId: z.number().int().positive(),
  githubTokenMode: z.literal('github_app').default('github_app'),
}).optional();
