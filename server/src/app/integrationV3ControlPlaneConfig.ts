import { z } from 'zod';

export const integrationV3ControlPlaneConfigSchema = z.object({
  enabled: z.boolean(),
  controlledMirrorRoot: z.string().min(1),
  runtimeIsolationEnforced: z.boolean(),
  githubTokenMode: z.enum(['github_app', 'restricted_pat']),
}).optional();
