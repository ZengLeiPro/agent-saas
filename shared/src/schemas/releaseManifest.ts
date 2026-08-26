import { z } from 'zod';

export const releaseComponentSchema = z.enum(['web', 'api', 'runtimeWorker', 'acs']);
export const RELEASE_COMPONENTS = ['web', 'api', 'runtimeWorker', 'acs'] as const;

export const releaseIdSchema = z
  .string()
  .regex(/^rc-\d{8}-\d{2,}$/, 'Expected rc-YYYYMMDD-NN release ID');
export const fullShaSchema = z
  .string()
  .regex(/^[a-f0-9]{40}$/, 'Expected a lowercase complete 40-character SHA');
export const sha256DigestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/, 'Expected a sha256:<lowercase hexadecimal> digest');
const utcTimestampSchema = z.iso.datetime({ offset: false, precision: 3 });

const artifactUriSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .superRefine((value, ctx) => {
    try {
      const uri = new URL(value);
      if (!uri.protocol || uri.username || uri.password || uri.search || uri.hash) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Artifact URI must not contain credentials, query strings, or fragments',
        });
      }
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Artifact URI must be absolute' });
    }
  });

const appComponentIdentitySchema = z
  .object({
    sourceSha: fullShaSchema,
    artifactDigest: sha256DigestSchema,
  })
  .strict();

const acsComponentIdentitySchema = z
  .object({
    sourceSha: fullShaSchema,
    orchestratorArtifactDigest: sha256DigestSchema,
    sandboxImageDigest: sha256DigestSchema,
  })
  .strict();

export const releaseComponentMatrixSchema = z
  .object({
    web: appComponentIdentitySchema,
    api: appComponentIdentitySchema,
    runtimeWorker: appComponentIdentitySchema,
    acs: acsComponentIdentitySchema,
  })
  .strict();

const appComponentPlanSchema = appComponentIdentitySchema
  .extend({
    action: z.enum(['deploy', 'keep']),
  })
  .strict();
const acsComponentPlanSchema = acsComponentIdentitySchema
  .extend({
    action: z.enum(['deploy', 'keep']),
  })
  .strict();

export const releaseComponentsPlanSchema = z
  .object({
    web: appComponentPlanSchema,
    api: appComponentPlanSchema,
    runtimeWorker: appComponentPlanSchema,
    acs: acsComponentPlanSchema,
  })
  .strict();

const fileArtifactSchema = z
  .object({
    uri: artifactUriSchema,
    digest: sha256DigestSchema,
    size: z.number().int().positive(),
  })
  .strict();

const optionalFileArtifactSchema = fileArtifactSchema.extend({ required: z.boolean() }).strict();
const imageArtifactSchema = z
  .object({
    required: z.boolean(),
    repository: z.string().trim().min(1).max(512),
    digest: sha256DigestSchema,
  })
  .strict();

export const releaseArtifactsSchema = z
  .object({
    serverBundle: fileArtifactSchema,
    webAssets: fileArtifactSchema,
    acsOrchestrator: optionalFileArtifactSchema,
    acsImage: imageArtifactSchema,
  })
  .strict();

const integrationCandidateSchema = z
  .object({
    candidateId: z.uuid(),
    revision: z.number().int().positive(),
    mergedCommitOid: fullShaSchema,
  })
  .strict();

const ciCheckSchema = z
  .object({
    status: z.literal('success'),
    headSha: fullShaSchema,
    runId: z.number().int().positive(),
  })
  .strict();
const acsImpactCheckSchema = z
  .object({
    status: z.enum(['success', 'not_required']),
    headSha: fullShaSchema,
    runId: z.number().int().positive().optional(),
  })
  .strict();

export const releaseManifestContentSchema = z
  .object({
    schemaVersion: z.literal(1),
    releaseId: releaseIdSchema,
    releaseSha: fullShaSchema,
    tag: releaseIdSchema,
    createdAt: utcTimestampSchema,
    createdBy: z.string().trim().min(1).max(256),
    integrationCandidates: z.array(integrationCandidateSchema).min(1).max(1_000),
    sourcePullRequests: z.array(z.number().int().positive()).min(1).max(1_000),
    productionBaseline: releaseComponentMatrixSchema,
    components: releaseComponentsPlanSchema,
    artifacts: releaseArtifactsSchema,
    checks: z
      .object({
        appCi: ciCheckSchema,
        acsImpact: acsImpactCheckSchema,
        integrationReceipt: z
          .object({
            status: z.literal('success'),
            subjectDigest: sha256DigestSchema,
          })
          .strict(),
      })
      .strict(),
    promotionPolicy: z
      .object({
        expiresAt: utcTimestampSchema,
        minimumPromotableSha: fullShaSchema,
        appAcsCompatibility: z.literal('n_and_n_plus_1'),
        requiresHumanApproval: z.literal(true),
      })
      .strict(),
    rollbackTargets: releaseComponentMatrixSchema,
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (manifest.tag !== manifest.releaseId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tag'],
        message: 'tag must equal releaseId',
      });
    }
    if (
      new Set(manifest.sourcePullRequests).size !== manifest.sourcePullRequests.length ||
      manifest.sourcePullRequests.some(
        (value, index, values) => index > 0 && value <= values[index - 1],
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourcePullRequests'],
        message: 'sourcePullRequests must be unique and ascending',
      });
    }
    if (
      (manifest.checks.acsImpact.status === 'success') !==
      (manifest.checks.acsImpact.runId !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['checks', 'acsImpact', 'runId'],
        message: 'ACS Impact success requires runId; not_required must not claim a run',
      });
    }
    if (Date.parse(manifest.promotionPolicy.expiresAt) <= Date.parse(manifest.createdAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['promotionPolicy', 'expiresAt'],
        message: 'promotion expiry must be later than Manifest creation',
      });
    }
    for (const [index, candidate] of manifest.integrationCandidates.entries()) {
      if (candidate.mergedCommitOid !== manifest.releaseSha) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['integrationCandidates', index, 'mergedCommitOid'],
          message: 'mergedCommitOid must equal releaseSha',
        });
      }
    }
    if (
      manifest.checks.appCi.headSha !== manifest.releaseSha ||
      manifest.checks.acsImpact.headSha !== manifest.releaseSha
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['checks'],
        message: 'check headSha values must equal releaseSha',
      });
    }

    for (const component of RELEASE_COMPONENTS) {
      const plan = manifest.components[component];
      const baseline = manifest.productionBaseline[component];
      const expectedSha = plan.action === 'deploy' ? manifest.releaseSha : baseline.sourceSha;
      if (plan.sourceSha !== expectedSha) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['components', component, 'sourceSha'],
          message:
            plan.action === 'deploy'
              ? 'deploy sourceSha must equal releaseSha'
              : 'keep sourceSha must equal the production baseline',
        });
      }
      if (plan.action === 'keep') {
        for (const [key, value] of Object.entries(baseline)) {
          if ((plan as Record<string, unknown>)[key] !== value) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['components', component, key],
              message: 'keep component identity must equal the production baseline',
            });
          }
        }
      }
    }

    const { components, artifacts } = manifest;
    const digestBindings: Array<[unknown, unknown, (string | number)[]]> = [
      [
        components.web.artifactDigest,
        artifacts.webAssets.digest,
        ['components', 'web', 'artifactDigest'],
      ],
      [
        components.api.artifactDigest,
        artifacts.serverBundle.digest,
        ['components', 'api', 'artifactDigest'],
      ],
      [
        components.runtimeWorker.artifactDigest,
        artifacts.serverBundle.digest,
        ['components', 'runtimeWorker', 'artifactDigest'],
      ],
      [
        components.acs.orchestratorArtifactDigest,
        artifacts.acsOrchestrator.digest,
        ['components', 'acs', 'orchestratorArtifactDigest'],
      ],
      [
        components.acs.sandboxImageDigest,
        artifacts.acsImage.digest,
        ['components', 'acs', 'sandboxImageDigest'],
      ],
    ];
    for (const [componentDigest, artifactDigest, path] of digestBindings) {
      if (componentDigest !== artifactDigest)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: 'component digest must match its immutable artifact',
        });
    }
    const acsDeploy = components.acs.action === 'deploy';
    if (
      artifacts.acsOrchestrator.required !== acsDeploy ||
      artifacts.acsImage.required !== acsDeploy
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['artifacts'],
        message: 'ACS artifact required flags must match the ACS component action',
      });
    }
    if (canonicalJson(manifest.rollbackTargets) !== canonicalJson(manifest.productionBaseline)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rollbackTargets'],
        message: 'initial rollback targets must equal the frozen production baseline',
      });
    }
  });

export const releaseManifestSchema = releaseManifestContentSchema
  .extend({
    digest: sha256DigestSchema,
  })
  .strict();

export type ReleaseComponent = z.infer<typeof releaseComponentSchema>;
export type ReleaseComponentMatrix = z.infer<typeof releaseComponentMatrixSchema>;
export type ReleaseComponentsPlan = z.infer<typeof releaseComponentsPlanSchema>;
export type ReleaseArtifacts = z.infer<typeof releaseArtifactsSchema>;
export type ReleaseManifestContent = z.infer<typeof releaseManifestContentSchema>;
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

export type CanonicalJsonValue =
  null | boolean | number | string | CanonicalJsonValue[] | { [key: string]: CanonicalJsonValue };

function normalizeCanonicalJson(value: unknown): CanonicalJsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new TypeError('Canonical JSON does not allow non-finite numbers');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    const normalized: CanonicalJsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new TypeError('Canonical JSON does not allow sparse arrays');
      normalized.push(normalizeCanonicalJson(value[index]));
    }
    return normalized;
  }
  if (typeof value !== 'object') throw new TypeError('Canonical JSON only supports JSON values');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError('Canonical JSON only supports plain objects');
  const normalized: { [key: string]: CanonicalJsonValue } = {};
  for (const key of Object.keys(value).sort())
    normalized[key] = normalizeCanonicalJson((value as Record<string, unknown>)[key]);
  return normalized;
}

export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(normalizeCanonicalJson(value));
  if (serialized === undefined) throw new TypeError('Canonical JSON serialization failed');
  return serialized;
}

export const canonicalizeJson = canonicalJson;
